"""Route pipelines: bounded context selection -> Gemma prompt -> JSON validation -> typed result.

Validators raise OutputValidationError for problems the model can fix (wrong types, fabricated
segment/source ids, out-of-range numbers); GemmaClient.generate_json then performs one repair
retry. Ungrounded evidence quotes are dropped rather than repaired, so nothing invented survives.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import OrderedDict
from datetime import datetime
from typing import Any, Optional

from .errors import AIServiceError
from .gemma import GemmaClient, OutputValidationError
from .prompts import PROMPT_VERSIONS, render, untrusted
from .schemas import (
    AIQuestionEvaluation,
    CatchUpRequest,
    CatchUpResponse,
    EvaluateQuestionRequest,
    ExplainRequest,
    ExplainResponse,
    MatchRequest,
    MatchResponse,
    ProfileRequest,
    ProfileResponse,
    QuestionTopic,
    Rationale,
    Segment,
    Skill,
    Source,
    TopicEvidence,
)
from .search import BraveSearch, clean_text, is_safe_public_url

CV_PROMPT_CHARS = 16_000
CATCH_UP_CONTEXT_CHARS = 6_000
EXPLAIN_CONTEXT_CHARS = 3_000
JUDGE_CONTEXT_CHARS = 5_000
JUDGE_MIN_CONTEXT_CHARS = 40
QUESTION_WINDOW_SECONDS = 180
UNCERTAINTY = ("low", "medium", "high")

# ---- helpers ------------------------------------------------------------------------------

_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "„": '"', "–": "-", "—": "-"})


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").translate(_QUOTES)).strip().lower()


def is_grounded(quote: str, source_text: str) -> bool:
    q = _norm(quote).strip(" .,:;\"'")
    return len(q) >= 3 and q in _norm(source_text)


def _lift_misplaced(obj: dict, keys: tuple[str, ...], containers: tuple[str, ...] = ("rationale",)) -> dict:
    """Small models sometimes nest a top-level key inside another object (observed with
    gemma4:e2b: ``source_segment_ids`` inside ``rationale``). Move it back up; values are not
    altered, and they are still validated afterwards."""
    for container in containers:
        inner = obj.get(container)
        if isinstance(inner, dict):
            for key in keys:
                if key not in obj and key in inner:
                    obj[key] = inner.pop(key)
    return obj


def _req_list(obj: dict, key: str) -> list:
    val = obj.get(key)
    if not isinstance(val, list):
        raise OutputValidationError(f'"{key}" must be a JSON array.')
    return val


def _req_str(obj: dict, key: str, *, allow_empty: bool = False) -> str:
    val = obj.get(key)
    if not isinstance(val, str) or (not allow_empty and not val.strip()):
        raise OutputValidationError(f'"{key}" must be a non-empty string.')
    return val


def _score(val: Any, key: str, lo: float, hi: float) -> Optional[float]:
    if val is None:
        return None
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        raise OutputValidationError(f'"{key}" must be a number between {lo} and {hi} or null.')
    if not lo <= float(val) <= hi:
        raise OutputValidationError(f'"{key}" must be between {lo} and {hi}.')
    return float(val)


def select_segments(segments: list[Segment], max_chars: int, max_count: int = 60) -> list[Segment]:
    """Most recent ready, non-empty segments (chronological order) within a character budget."""
    ready = sorted((s for s in segments if s.status == "ready" and s.text.strip()), key=lambda s: s.sequence)
    picked: list[Segment] = []
    used = 0
    for seg in reversed(ready):
        if len(picked) >= max_count or (picked and used + len(seg.text) > max_chars):
            break
        picked.append(seg)
        used += len(seg.text)
    return list(reversed(picked))


def _seg_payload(segments: list[Segment]) -> list[dict]:
    return [{"id": s.id, "text": s.text[:1500]} for s in segments]


def _ordered_ids(ids: list, valid_order: list[str], key: str) -> list[str]:
    if not all(isinstance(i, str) for i in ids):
        raise OutputValidationError(f'"{key}" must contain strings.')
    unknown = [i for i in ids if i not in valid_order]
    if unknown:
        raise OutputValidationError(f'"{key}" contains ids not present in the input: {unknown[:5]}. Use only input ids.')
    wanted = set(ids)
    return [i for i in valid_order if i in wanted]


def _map_to_allowed(topic: str, allowed: list[str]) -> Optional[str]:
    if not allowed:
        return clean_text(topic, 80) or None
    by_norm = {_norm(a): a for a in allowed}
    return by_norm.get(_norm(topic))


class LRUCache:
    def __init__(self, size: int = 256):
        self.size = size
        self._data: OrderedDict[str, Any] = OrderedDict()

    def get(self, key: str) -> Any:
        if key in self._data:
            self._data.move_to_end(key)
            return self._data[key]
        return None

    def put(self, key: str, value: Any) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self.size:
            self._data.popitem(last=False)


# ---- /profile -----------------------------------------------------------------------------

async def build_profile(gemma: GemmaClient, req: ProfileRequest) -> ProfileResponse:
    cv = req.cv_text[:CV_PROMPT_CHARS]
    event_topics = [t for t in dict.fromkeys(clean_text(t, 120) for t in req.event_topics) if t]
    prompt = render("profile", data=untrusted({"event_topics": event_topics, "cv_text": cv}))

    def validate(obj: dict) -> ProfileResponse:
        skills: list[Skill] = []
        for item in _req_list(obj, "skills")[:40]:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                raise OutputValidationError('Each skill needs "name" and "evidence" strings.')
            evidence = item.get("evidence") if isinstance(item.get("evidence"), str) else ""
            if item["name"].strip() and is_grounded(evidence, cv):
                skills.append(Skill(name=clean_text(item["name"], 120), evidence=clean_text(evidence, 400)))

        raw_topics: dict[str, dict] = {}
        for item in _req_list(obj, "topic_estimates"):
            if not isinstance(item, dict) or not isinstance(item.get("topic"), str):
                raise OutputValidationError('Each topic estimate needs a "topic" string.')
            raw_topics.setdefault(_norm(item["topic"]), item)
        topics_out = event_topics or [clean_text(i.get("topic", ""), 120) for i in raw_topics.values()][:10]
        estimates: list[TopicEvidence] = []
        for topic in topics_out:
            if not topic:
                continue
            item = raw_topics.get(_norm(topic), {})
            baseline = _score(item.get("baseline"), "baseline", 0, 100)
            ev = item.get("evidence") if isinstance(item.get("evidence"), list) else []
            grounded = [clean_text(e, 300) for e in ev if isinstance(e, str) and is_grounded(e, cv)][:5]
            unc = item.get("uncertainty") if item.get("uncertainty") in UNCERTAINTY else "high"
            if not grounded:
                # No CV quote supports this topic: estimate is unsupported, never invented.
                baseline, unc = None, "high"
            estimates.append(TopicEvidence(topic=topic, baseline=baseline, uncertainty=unc, evidence=grounded))

        interests = [clean_text(i, 80) for i in _req_list(obj, "interests") if isinstance(i, str)]
        interests = [i for i in dict.fromkeys(interests) if i][:8]
        return ProfileResponse(skills=skills, topic_estimates=estimates, interests=interests, model_id=gemma.model_id)

    result, _ = await gemma.generate_json(prompt, validate, route="profile", max_tokens=1500)
    return result


# ---- /catch-up ----------------------------------------------------------------------------

_SENTENCE_END = re.compile(r"[.!?…]+(?=\s|$)")


async def catch_up(gemma: GemmaClient, req: CatchUpRequest, cache: LRUCache) -> CatchUpResponse:
    segments = select_segments(req.segments, CATCH_UP_CONTEXT_CHARS, max_count=40)
    if not segments:
        raise AIServiceError(422, "NO_TRANSCRIPT", "No ready transcript segments were supplied; nothing to summarise.")
    seg_ids = [s.id for s in segments]
    key = hashlib.sha256(json.dumps(
        [PROMPT_VERSIONS["catch_up"], gemma.model_id, req.locale, [(s.id, s.sequence, s.text) for s in segments]],
        ensure_ascii=False,
    ).encode()).hexdigest()
    cached = cache.get(key)
    if cached is not None:
        return cached

    prompt = render("catch_up", locale=clean_text(req.locale, 20), data=untrusted({"segments": _seg_payload(segments)}))

    def validate(obj: dict) -> CatchUpResponse:
        cue = clean_text(_req_str(obj, "cue"), 80).strip(" .")
        if not 3 <= len(cue.split()) <= 5:
            raise OutputValidationError('"cue" must be 3 to 5 words.')
        summary = clean_text(_req_str(obj, "summary"), 600)
        if len(_SENTENCE_END.findall(summary)) > 3:
            raise OutputValidationError('"summary" must be 1 to 3 sentences.')
        ids = _ordered_ids(_req_list(obj, "source_segment_ids"), seg_ids, "source_segment_ids")
        if not ids:
            raise OutputValidationError('"source_segment_ids" must reference at least one input segment.')
        return CatchUpResponse(cue=cue, summary=summary, source_segment_ids=ids, model_id=gemma.model_id)

    result, _ = await gemma.generate_json(prompt, validate, route="catch-up", max_tokens=400)
    cache.put(key, result)
    return result


# ---- /explain -----------------------------------------------------------------------------

async def explain(gemma: GemmaClient, search: BraveSearch, req: ExplainRequest) -> ExplainResponse:
    term = clean_text(req.term, 200)
    if not term:
        raise AIServiceError(422, "VALIDATION_ERROR", "term is empty.")
    context = select_segments(req.segments, EXPLAIN_CONTEXT_CHARS, max_count=20)

    # Candidate sources: backend-provided (validated) + raw Brave web results for the term only.
    candidates: dict[str, tuple[Source, str, str]] = {}  # id -> (source, origin, snippet)
    for src in req.provided_sources:
        if is_safe_public_url(src.url) and src.id not in candidates:
            candidates[src.id] = (Source(id=src.id, title=clean_text(src.title, 200) or src.url, url=src.url), "provided", "")
    for n, hit in enumerate(await search.search(term), start=1):
        sid = f"web-{n}"
        candidates[sid] = (Source(id=sid, title=hit.title, url=hit.url), "web", hit.snippet)

    background = [
        {"topic": b.topic, "familiarity": b.baseline, "uncertainty": b.uncertainty} for b in req.background[:15]
    ]  # CV evidence quotes are deliberately not forwarded.
    data = {
        "term": term,
        # Plain text only: segment ids here were confused with source ids by gemma4:e2b.
        "talk_context": [s.text[:1500] for s in context],
        "attendee_background": background,
        "sources": [{"id": sid, "title": s.title, "url": s.url, "snippet": snip}
                    for sid, (s, _, snip) in candidates.items()],
    }
    source_rule = (
        "Base the explanation on the sources where they cover the term; if they do not, explain from general "
        "knowledge and return an empty used_source_ids list."
        if candidates else
        "No sources are available. Explain from general knowledge and return \"used_source_ids\": []."
    )
    prompt = render("explain", depth=req.depth, locale=clean_text(req.locale, 20), source_rule=source_rule,
                    data=untrusted(data))
    candidate_ids = list(candidates)

    def validate(obj: dict) -> ExplainResponse:
        explanation = clean_text(_req_str(obj, "explanation"), 1500)
        example = clean_text(_req_str(obj, "example", allow_empty=True), 700)
        used = _ordered_ids(_req_list(obj, "used_source_ids"), candidate_ids, "used_source_ids")
        origins = {candidates[i][1] for i in used}
        mode = "web" if "web" in origins else "provided" if "provided" in origins else "general"
        return ExplainResponse(explanation=explanation, example=example,
                               sources=[candidates[i][0] for i in used], retrieval_mode=mode,
                               model_id=gemma.model_id)

    result, _ = await gemma.generate_json(prompt, validate, route="explain", max_tokens=700)
    return result


# ---- /evaluate-question ---------------------------------------------------------------------

# Deterministic backstop for the rubric's generic repeat/clarify rule. Only whole-question
# matches count: a core phrase plus filler words, nothing topical.
_GENERIC_CORE = (
    r"mo(?:z|ž)e(?:te|[sš])?\s+li(?:\s+da)?(?:\s+(?:ponovi(?:te|ti|[sš])?|re[cč]i\s+ponovo))?(?:\s+malo)?(?:\s+(?:glasnije|sporije))?"
    r"|ponovite|ponovi"
    r"|nisam\s+(?:[cč]uo|[cč]ula|razumeo|razumela|razumio|razumjela|uhvatio|uhvatila)"
    r"|glasnije|sporije"
    r"|(?:can|could|would)\s+you\s+(?:please\s+)?(?:repeat|say\s+(?:that|it)\s+again|speak\s+(?:up|louder)|go\s+back)"
    r"|sorry|pardon|excuse\s+me|what|molim|[sš]ta|izvinite"
    r"|repeat"
    r"|what\s+did\s+you\s+(?:just\s+)?say"
    r"|i\s+didn'?t\s+(?:hear|catch|get|understand)"
)
_GENERIC_FILLER = (
    r"(?:[\s,]+(?:molim(?:\s+vas)?|please|again|that|this|it|ponovo|jo[sš]\s+jednom|to|ovo|vas|"
    r"(?:poslednj|zadnj)(?:i|u|e)\s+(?:deo|dio|re[cč]enicu|slajd)|the\s+last\s+(?:part|sentence|bit|slide)|"
    r"what\s+you\s+(?:just\s+)?said|[sš]to\s+ste\s+(?:upravo\s+)?rekli|sorry|izvinite|"
    r"ponovi(?:te|ti)?|glasnije|sporije|malo))*"
)
_GENERIC_PATTERNS = re.compile(
    rf"^\W*(?:(?:molim\s+vas|izvinite|sorry|excuse\s+me)[\s,]+)?(?:{_GENERIC_CORE}){_GENERIC_FILLER}\W*$",
    re.IGNORECASE,
)


def is_generic_clarification(question: str) -> bool:
    q = question.strip()
    return len(q) <= 120 and bool(_GENERIC_PATTERNS.match(q))


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _topics(raw: list, question: str, allowed: list[str]) -> list[QuestionTopic]:
    out: list[QuestionTopic] = []
    for item in raw[:6]:
        if not isinstance(item, dict) or not isinstance(item.get("topic"), str):
            continue
        topic = _map_to_allowed(item["topic"], allowed)
        evidence = item.get("evidence") if isinstance(item.get("evidence"), str) else ""
        if not topic or not is_grounded(evidence, question) or topic in {t.topic for t in out}:
            continue
        conf = item.get("confidence") if item.get("confidence") in UNCERTAINTY else "low"
        out.append(QuestionTopic(topic=topic, evidence=clean_text(evidence, 400), confidence=conf))
    return out[:3]


async def evaluate_question(gemma: GemmaClient, req: EvaluateQuestionRequest) -> AIQuestionEvaluation:
    submitted, window_start = _parse_ts(req.submitted_at), _parse_ts(req.window_start_at)
    span = (submitted - window_start).total_seconds()
    if span < 0 or span > QUESTION_WINDOW_SECONDS + 5:
        raise AIServiceError(422, "INVALID_WINDOW",
                             f"window_start_at must be 0-{QUESTION_WINDOW_SECONDS}s before submitted_at.")

    rubric = PROMPT_VERSIONS["evaluate_question"]
    question = req.question_text
    allowed = [t for t in dict.fromkeys(clean_text(t, 120) for t in req.allowed_topics) if t]
    allowed_str = json.dumps(allowed, ensure_ascii=False) if allowed else "(none given)"
    rule_generic = is_generic_clarification(question)
    context = select_segments(req.segments, JUDGE_CONTEXT_CHARS) if req.context_available else []
    sufficient = bool(context) and sum(len(s.text) for s in context) >= JUDGE_MIN_CONTEXT_CHARS

    if not sufficient:
        no_ctx = "Transcript context for the preceding three minutes was unavailable or too short."
        if rule_generic:
            # Deterministic rule; no model call was made, so model_id says so honestly.
            return AIQuestionEvaluation(
                relevance=None, expertise=0, depth=0, topics=[],
                rationale=Rationale(relevance=no_ctx, expertise="Generic repeat/clarify request.",
                                    depth="Generic repeat/clarify request."),
                source_segment_ids=[], context_status="insufficient", is_generic_clarification=True,
                model_id="rule:generic-clarification", rubric_version=rubric)
        prompt = render("evaluate_question_topics", allowed_topics=allowed_str,
                        data=untrusted({"question_text": question}))

        def validate_topics(obj: dict) -> AIQuestionEvaluation:
            generic = obj.get("is_generic_clarification") is True
            return AIQuestionEvaluation(
                relevance=None, expertise=0 if generic else None, depth=0 if generic else None,
                topics=[] if generic else _topics(_req_list(obj, "topics"), question, allowed),
                rationale=Rationale(relevance=no_ctx, expertise="Not judged without context." if not generic else
                                    "Generic repeat/clarify request.",
                                    depth="Not judged without context." if not generic else
                                    "Generic repeat/clarify request."),
                source_segment_ids=[], context_status="insufficient", is_generic_clarification=generic,
                model_id=gemma.model_id, rubric_version=rubric)

        result, _ = await gemma.generate_json(prompt, validate_topics, route="evaluate-question", max_tokens=400)
        return result

    seg_ids = [s.id for s in context]
    # Only the question text and transcript text reach the model: no identity, CV or timestamps.
    prompt = render("evaluate_question", allowed_topics=allowed_str,
                    data=untrusted({"question_text": question, "transcript_segments": _seg_payload(context)}))

    def validate(obj: dict) -> AIQuestionEvaluation:
        _lift_misplaced(obj, ("source_segment_ids", "topics", "is_generic_clarification"))
        scores = {}
        for key in ("relevance", "expertise", "depth"):
            val = _score(obj.get(key), key, 0, 10)
            if val is None:
                raise OutputValidationError(f'"{key}" must be a number from 0 to 10 when context is provided.')
            scores[key] = val
        generic = obj.get("is_generic_clarification") is True or rule_generic
        if generic:
            scores["expertise"] = scores["depth"] = 0.0
        rat = obj.get("rationale") if isinstance(obj.get("rationale"), dict) else {}
        rationale = Rationale(**{k: clean_text(str(rat.get(k) or ""), 300) for k in ("relevance", "expertise", "depth")})
        ids = _ordered_ids(_req_list(obj, "source_segment_ids"), seg_ids, "source_segment_ids")
        return AIQuestionEvaluation(
            **scores, topics=[] if generic else _topics(_req_list(obj, "topics"), question, allowed),
            rationale=rationale, source_segment_ids=ids, context_status="sufficient",
            is_generic_clarification=generic, model_id=gemma.model_id, rubric_version=rubric)

    result, _ = await gemma.generate_json(prompt, validate, route="evaluate-question", max_tokens=600)
    return result


# ---- /match -------------------------------------------------------------------------------

async def match(gemma: GemmaClient, req: MatchRequest) -> MatchResponse:
    opp = req.opportunity
    questions = req.questions[:20]
    required = [r for r in dict.fromkeys(clean_text(r, 120) for r in opp.required_skills) if r]
    data = {
        "opportunity": {"title": clean_text(opp.title, 200), "topics": [clean_text(t, 120) for t in opp.topics],
                        "required_skills": required},
        "cv_skills": [{"name": s.name, "evidence": s.evidence[:300]} for s in req.profile_evidence.skills[:30]],
        "interests": req.profile_evidence.interests[:20],
        "questions": [{"index": i, "text": q.text, "topics": q.topics} for i, q in enumerate(questions)],
    }
    prompt = render("match", data=untrusted(data))
    by_norm = {_norm(r): r for r in required}

    def validate(obj: dict) -> MatchResponse:
        reasons = [clean_text(r, 300) for r in _req_list(obj, "reasons") if isinstance(r, str)]
        reasons = [r for r in reasons if r][:4]
        if not reasons:
            raise OutputValidationError('"reasons" must contain at least one string.')
        missing = [by_norm[_norm(m)] for m in _req_list(obj, "missing_requirements")
                   if isinstance(m, str) and _norm(m) in by_norm]
        idx = _req_list(obj, "supported_question_indices")
        if not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(questions) for i in idx):
            raise OutputValidationError(
                f'"supported_question_indices" must only contain integers 0..{len(questions) - 1}.' if questions
                else '"supported_question_indices" must be [] because there are no questions.')
        return MatchResponse(reasons=reasons, missing_requirements=list(dict.fromkeys(missing)),
                             supported_question_indices=sorted(set(idx)), model_id=gemma.model_id)

    result, _ = await gemma.generate_json(prompt, validate, route="match", max_tokens=600)
    return result
