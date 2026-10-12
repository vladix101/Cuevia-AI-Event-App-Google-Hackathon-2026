"""Client for the private AI service, matching contracts/ai-v1.md.

The AI service has no authority over roles, quotas, grants or rankings: backend sends bounded,
validated context and applies deterministic policy (policy.py) to whatever comes back.
Any transport/validation failure raises AIError; callers must surface pending/error states,
never invent output.
"""
from typing import Literal

import httpx
from pydantic import BaseModel, Field, ValidationError, model_validator

from .config import get_settings

Confidence = Literal["low", "medium", "high"]


class AIError(Exception):
    pass


class _M(BaseModel):
    # Tolerate extra keys from the provider-facing service, keep only contract fields.
    model_config = {"extra": "ignore"}


class Skill(_M):
    name: str
    evidence: str


class TopicEvidence(_M):
    topic: str
    baseline: float | None = Field(default=None, ge=0, le=100)
    uncertainty: Confidence
    evidence: list[str] = []


class ProfileResult(_M):
    skills: list[Skill]
    topic_estimates: list[TopicEvidence]
    interests: list[str]
    model_id: str


class TranscribeResult(_M):
    text: str
    model_id: str


class CatchUpResult(_M):
    cue: str
    summary: str
    source_segment_ids: list[str]
    model_id: str


class SourceM(_M):
    id: str
    title: str
    url: str


class ExplainResult(_M):
    explanation: str
    example: str
    sources: list[SourceM]
    retrieval_mode: Literal["web", "provided", "general"]
    model_id: str


class QuestionTopic(_M):
    topic: str
    evidence: str
    confidence: Confidence


class Rationale(_M):
    relevance: str
    expertise: str
    depth: str


class AIQuestionEvaluation(_M):
    relevance: float | None = Field(default=None, ge=0, le=10)
    expertise: float | None = Field(default=None, ge=0, le=10)
    depth: float | None = Field(default=None, ge=0, le=10)
    topics: list[QuestionTopic]
    rationale: Rationale
    source_segment_ids: list[str]
    context_status: Literal["sufficient", "insufficient"]
    is_generic_clarification: bool
    model_id: str
    rubric_version: str

    @model_validator(mode="after")
    def _scores_when_sufficient(self):
        if self.context_status == "sufficient" and None in (self.relevance, self.expertise, self.depth):
            raise ValueError("sufficient context requires all three 0-10 scores")
        return self


class MatchResult(_M):
    reasons: list[str]
    missing_requirements: list[str]
    supported_question_indices: list[int]
    model_id: str


class AIClient:
    def __init__(self, transport: httpx.BaseTransport | None = None):
        s = get_settings()
        self._http = httpx.Client(
            base_url=s.ai_service_url.rstrip("/"),
            headers={"X-Internal-Token": s.ai_service_token},
            timeout=s.ai_timeout_seconds,
            transport=transport,
        )

    def _post(self, path: str, model: type[BaseModel], **kwargs):
        try:
            r = self._http.post(path, **kwargs)
        except httpx.HTTPError as e:
            raise AIError(f"{path}: transport error {type(e).__name__}") from None
        if r.status_code != 200:
            raise AIError(f"{path}: HTTP {r.status_code}")
        try:
            return model.model_validate(r.json())
        except (ValueError, ValidationError) as e:
            raise AIError(f"{path}: invalid response ({type(e).__name__})") from None

    def health(self) -> bool:
        try:
            r = self._http.get("/health", timeout=3)
            return r.status_code == 200 and r.json().get("contract_version") == "1"
        except Exception:
            return False

    def profile(self, cv_text: str, event_topics: list[str]) -> ProfileResult:
        return self._post("/profile", ProfileResult, json={"cv_text": cv_text, "event_topics": event_topics})

    def transcribe(self, audio: bytes, content_type: str, language: str) -> TranscribeResult:
        files = {"file": ("chunk", audio, content_type)}
        return self._post("/transcribe", TranscribeResult, files=files, data={"language": language})

    def catch_up(self, segments: list[dict], locale: str) -> CatchUpResult:
        return self._post("/catch-up", CatchUpResult, json={"segments": segments, "locale": locale})

    def explain(self, term: str, segments: list[dict], background: list[dict], depth: str, locale: str) -> ExplainResult:
        body = {"term": term, "segments": segments, "background": background, "depth": depth,
                "locale": locale, "provided_sources": []}
        return self._post("/explain", ExplainResult, json=body)

    def evaluate_question(self, question_text: str, segments: list[dict], submitted_at: str,
                          window_start_at: str, allowed_topics: list[str], locale: str) -> AIQuestionEvaluation:
        body = {"question_text": question_text, "segments": segments, "submitted_at": submitted_at,
                "window_start_at": window_start_at, "allowed_topics": allowed_topics,
                "context_available": bool(segments), "locale": locale}
        return self._post("/evaluate-question", AIQuestionEvaluation, json=body)

    def match(self, opportunity: dict, profile_evidence: dict, questions: list[dict]) -> MatchResult:
        body = {"opportunity": opportunity, "profile_evidence": profile_evidence, "questions": questions}
        return self._post("/match", MatchResult, json=body)


_client: AIClient | None = None


def get_ai() -> AIClient:
    global _client
    if _client is None:
        _client = AIClient()
    return _client


def set_ai(client: AIClient) -> None:
    """Used by tests to inject a client built on the deterministic fixture transport."""
    global _client
    _client = client
