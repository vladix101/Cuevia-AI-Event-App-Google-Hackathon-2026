import logging
import uuid
from collections import Counter, defaultdict

from fastapi import APIRouter, Depends

from .. import firebase
from ..ai_client import AIError, get_ai
from ..auth import User, current_user, get_talk, require_organizer
from ..config import get_settings
from ..errors import bad_request
from ..policy import (RANKING_VERSION, Candidate, current_estimates, has_known_baseline, is_good, norm_topic,
                      top_k, topic_bonuses)
from ..schemas import Configured, Finalized, Metrics, TermCount, TopicCount, TranscriptSourceBody
from .events import baselines_of, private_profile_ref, public_interests
from .recordings import get_recording
from .sponsors import current_consent

router = APIRouter()
log = logging.getLogger("cuevia.organizer")


@router.post("/organizer/talks/{talk_id}/transcript-source", response_model=Configured)
def set_transcript_source(talk_id: str, body: TranscriptSourceBody, user: User = Depends(current_user)):
    talk = get_talk(talk_id)
    event = require_organizer(talk["event_id"], user)
    rec = get_recording(body.recording_id)
    if rec["talk_id"] != talk_id:
        raise bad_request("Recording belongs to a different talk")
    trusted = set(event.get("organizer_uids", [])) | set(talk.get("speaker_uids", []))
    if rec["owner_uid"] not in trusted:
        raise bad_request("Only organizer or speaker recordings can be the authoritative transcript")
    firebase.db().collection("talks").document(talk_id).update({"transcript_source": {
        "recording_id": body.recording_id, "configured_by": user.uid, "configured_at": firebase.now()}})
    return Configured()


def _deterministic_reasons(relevant_topics: list[str]) -> list[str]:
    return [f"CV pokriva temu: {t}" for t in relevant_topics]


@router.post("/organizer/events/{event_id}/finalize-shortlists", response_model=Finalized)
def finalize(event_id: str, user: User = Depends(current_user)):
    require_organizer(event_id, user)
    s = get_settings()
    db = firebase.db()

    judgments_by_user: dict[str, list[dict]] = defaultdict(list)
    for j in db.collection("question_judgments").where("event_id", "==", event_id).stream():
        judgments_by_user[j.get("user_id")].append({"id": j.id, **j.to_dict()})

    profiles: dict[str, dict] = {}
    candidates: dict[str, Candidate] = {}
    for p in db.collection("profiles").where("event_id", "==", event_id).where("cv_status", "==", "parsed").stream():
        uid = p.get("user_id")
        private = private_profile_ref(event_id, uid).get().to_dict()
        baselines = baselines_of(private)
        if not has_known_baseline(baselines):
            continue
        bonuses = topic_bonuses(judgments_by_user[uid], s.gate_min_relevance, s.topic_bonus_cap)
        candidates[uid] = Candidate(uid, current_estimates(baselines, bonuses))
        profiles[uid] = {**p.to_dict(), "skills": private.get("skills", [])}

    entries = []
    for o in db.collection("opportunities").where("event_id", "==", event_id).stream():
        opp = {"id": o.id, **o.to_dict()}
        consenting = [c for uid, c in sorted(candidates.items())
                      if current_consent(event_id, uid, opp["recipient_id"]).get("allow_cv")]
        for c in top_k(consenting, opp["topics"], s.top_k):
            relevant = [t for t in opp["topics"] if c.estimates.get(norm_topic(t)) is not None]
            opp_topics = {norm_topic(t) for t in opp["topics"]}
            good = [j for j in judgments_by_user[c.participant_id] if is_good(j, s.gate_min_relevance)
                    and opp_topics & {norm_topic(t["topic"]) for t in j.get("topics", [])}]
            q_docs = [(j["id"], db.collection("questions").document(j["id"]).get().to_dict()) for j in good][:10]
            reasons, question_ids, match_model = _deterministic_reasons(relevant), [qid for qid, _ in q_docs], None
            try:
                m = get_ai().match(
                    {"id": opp["id"], "title": opp["title"], "topics": opp["topics"],
                     "required_skills": opp.get("required_skills", [])},
                    {"skills": profiles[c.participant_id]["skills"],
                     "interests": [i.topic for i in public_interests(profiles[c.participant_id])]},
                    [{"text": q["text"], "topics": [t["topic"] for t in j["topics"]]}
                     for (_, q), j in zip(q_docs, good)])
                # AI explains fit only; it cannot add or reorder candidates.
                reasons = [r[:300] for r in m.reasons[:5]] or reasons
                question_ids = [q_docs[i][0] for i in m.supported_question_indices if 0 <= i < len(q_docs)]
                match_model = m.model_id
            except AIError as e:
                log.warning("match unavailable for opportunity %s: %s", opp["id"], e)
            entries.append({"opportunity_id": opp["id"], "recipient_id": opp["recipient_id"],
                            "participant_id": c.participant_id, "reasons": reasons,
                            "question_ids": question_ids, "match_model_id": match_model})

    sid = uuid.uuid4().hex
    prev = (db.collection("events").document(event_id).get().to_dict() or {}).get("snapshot_version") or 0
    db.collection("snapshots").document(sid).set({
        "event_id": event_id, "version": prev + 1, "policy_version": s.policy_version,
        "ranking_version": RANKING_VERSION, "created_at": firebase.now(), "created_by": user.uid, "entries": entries})
    db.collection("events").document(event_id).update({"current_snapshot_id": sid, "snapshot_version": prev + 1})
    return Finalized(snapshot_id=sid)


@router.get("/organizer/events/{event_id}/metrics", response_model=Metrics)
def metrics(event_id: str, user: User = Depends(current_user)):
    require_organizer(event_id, user)
    db = firebase.db()
    members = {m.id for m in db.collection("events").document(event_id).collection("members").stream()}
    parsed, estimated, interests = 0, 0, Counter()
    for p in db.collection("profiles").where("event_id", "==", event_id).stream():
        d = p.to_dict()
        if d["user_id"] not in members:
            continue
        for i in public_interests(d):
            interests[i.topic] += 1
        if d.get("cv_status") == "parsed":
            parsed += 1
            if has_known_baseline(baselines_of(private_profile_ref(event_id, d["user_id"]).get().to_dict())):
                estimated += 1
    stats = db.collection("event_stats").document(event_id)
    stats_doc = stats.get()
    terms = sorted(((t.get("term"), t.get("count")) for t in stats.collection("terms").stream()),
                   key=lambda x: (-x[1], x[0]))[:20]
    question_count = db.collection("questions").where("event_id", "==", event_id).count().get()[0][0].value
    shares = sum(1 for c in db.collection("consents").where("event_id", "==", event_id).stream()
                 if c.get("allow_cv") or c.get("allow_questions"))
    return Metrics(
        attendee_count=len(members), cv_parsed_count=parsed, na_count=len(members) - estimated,
        question_count=question_count,
        catch_up_count=(stats_doc.get("catch_up_count") if stats_doc.exists else 0) or 0,
        requested_terms=[TermCount(term=t, count=c) for t, c in terms],
        interest_distribution=[TopicCount(topic=t, count=c) for t, c in sorted(interests.items(), key=lambda x: (-x[1], x[0]))],
        share_count=shares)
