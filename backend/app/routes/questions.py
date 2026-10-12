import hashlib
from datetime import timedelta

from fastapi import APIRouter, Depends
from google.cloud import firestore as gcf

from .. import firebase, tasks
from ..ai_client import get_ai
from ..auth import User, current_user, get_event, get_talk, require_member, require_speaker_talk_ids
from ..config import get_settings
from ..errors import ApiError, forbidden, not_found
from ..policy import norm_topic
from ..schemas import QuestionCreate, QuestionCreated, QuestionList, QuestionPublic, Quota, ReadStatusPatch
from .events import profile_ref
from .recordings import rec_ref, to_segment

router = APIRouter()
RUBRIC_CONTEXT_VERSION = "ctx-v1"


def question_ref(qid: str):
    return firebase.db().collection("questions").document(qid)


def quota_ref(talk_id: str, uid: str):
    return firebase.db().collection("question_quotas").document(f"{talk_id}_{uid}")


def judgment_ref(qid: str):
    """Internal-only: AI ratings and frozen context. Never serialized to browsers."""
    return firebase.db().collection("question_judgments").document(qid)


def to_public(qid: str, q: dict) -> QuestionPublic:
    return QuestionPublic(id=qid, talk_id=q["talk_id"], text=q["text"],
                          submitted_at=firebase.rfc3339(q["submitted_at"]), read_status=q["read_status"])


def _quota(used: int) -> Quota:
    limit = get_settings().question_limit
    return Quota(used=used, limit=limit, remaining=max(0, limit - used))


@router.get("/talks/{talk_id}/question-quota", response_model=Quota)
def get_quota(talk_id: str, user: User = Depends(current_user)):
    require_member(get_talk(talk_id)["event_id"], user)
    snap = quota_ref(talk_id, user.uid).get()
    return _quota(snap.get("used") if snap.exists else 0)


@router.get("/talks/{talk_id}/questions", response_model=QuestionList)
def my_questions(talk_id: str, user: User = Depends(current_user)):
    require_member(get_talk(talk_id)["event_id"], user)
    docs = firebase.db().collection("questions").where("talk_id", "==", talk_id).where("user_id", "==", user.uid).stream()
    items = sorted((to_public(d.id, d.to_dict()) for d in docs), key=lambda q: q.submitted_at)
    return QuestionList(items=items)


@router.post("/talks/{talk_id}/questions", response_model=QuestionCreated, status_code=201)
def ask(talk_id: str, body: QuestionCreate, user: User = Depends(current_user)):
    talk = get_talk(talk_id)
    require_member(talk["event_id"], user)
    limit = get_settings().question_limit
    # Deterministic id = idempotency index: the same client_request_id always maps to the same document.
    qid = hashlib.sha256(f"{talk_id}|{user.uid}|{body.client_request_id}".encode()).hexdigest()[:32]
    qref, kref = question_ref(qid), quota_ref(talk_id, user.uid)
    text = " ".join(body.text.split())

    def txn(tx):
        qsnap, ksnap = qref.get(transaction=tx), kref.get(transaction=tx)
        if qsnap.exists:
            q = qsnap.to_dict()
            return to_public(qid, q), _quota(q["quota_used_after"])
        used = ksnap.get("used") if ksnap.exists else 0
        if used >= limit:
            raise ApiError(409, "QUESTION_LIMIT_REACHED", f"At most {limit} questions per talk")
        q = {"talk_id": talk_id, "event_id": talk["event_id"], "user_id": user.uid, "text": text,
             "client_request_id": body.client_request_id, "submitted_at": firebase.now(),
             "read_status": "unread", "quota_used_after": used + 1}
        tx.set(qref, q)
        tx.set(kref, {"used": used + 1, "talk_id": talk_id, "user_id": user.uid})
        tasks.enqueue(f"judge_{qid}", "judge_question", {"question_id": qid}, tx=tx)
        return to_public(qid, q), _quota(used + 1)

    question, quota = firebase.run_transaction(txn)
    return QuestionCreated(question=question, quota=quota)


@router.get("/speaker/events/{event_id}/questions", response_model=QuestionList)
def speaker_questions(event_id: str, user: User = Depends(current_user)):
    talk_ids = require_speaker_talk_ids(event_id, user)
    items = []
    for i in range(0, len(talk_ids), 30):  # Firestore "in" limit
        for d in firebase.db().collection("questions").where("talk_id", "in", talk_ids[i:i + 30]).stream():
            items.append(to_public(d.id, d.to_dict()))
    items.sort(key=lambda q: (q.talk_id, q.submitted_at))
    return QuestionList(items=items)


@router.patch("/speaker/questions/{question_id}", response_model=QuestionPublic)
def mark_read(question_id: str, body: ReadStatusPatch, user: User = Depends(current_user)):
    snap = question_ref(question_id).get()
    if not snap.exists:
        raise not_found("Question")
    q = snap.to_dict()
    if "speaker" not in user.roles or user.uid not in get_talk(q["talk_id"]).get("speaker_uids", []):
        raise forbidden("Only the assigned speaker can mark this question")
    question_ref(question_id).update({"read_status": body.read_status})
    return to_public(question_id, {**q, "read_status": body.read_status})


# ---------- background judging ----------

def select_context(source_recording_id: str, submitted_at, window_seconds: int) -> tuple[list[dict], bool]:
    """Authoritative segments fully inside [submitted_at - window, submitted_at]; never future speech.

    Returns (segments, still_pending) where still_pending means a chunk in the window is not processed yet.
    """
    window_start = submitted_at - timedelta(seconds=window_seconds)
    segs, pending = [], False
    for snap in rec_ref(source_recording_id).collection("chunks").where("end_at", ">", window_start).stream():
        c = snap.to_dict()
        if c["end_at"] > submitted_at:
            continue
        if c["status"] == "pending":
            pending = True
        elif c["status"] == "ready" and c["text"]:
            segs.append(to_segment(source_recording_id, c))
    segs.sort(key=lambda s: s["sequence"])
    return segs, pending


def _write_insufficient(qid: str, q: dict, context: dict) -> None:
    judgment_ref(qid).set({"status": "done", "context_status": "insufficient", "relevance": None, "expertise": None,
                           "depth": None, "is_generic_clarification": False, "topics": [], "context": context,
                           "user_id": q["user_id"], "event_id": q["event_id"], "talk_id": q["talk_id"],
                           "judged_at": firebase.now(), "model_id": None, "rubric_version": None})


def run_judge(payload: dict) -> None:
    s = get_settings()
    qid = payload["question_id"]
    q = question_ref(qid).get().to_dict()
    if q is None:
        return
    talk = get_talk(q["talk_id"])
    submitted = q["submitted_at"]
    waited = (firebase.now() - submitted).total_seconds()
    source = (talk.get("transcript_source") or {}).get("recording_id")
    window_start = submitted - timedelta(seconds=s.context_window_seconds)
    context = {"version": RUBRIC_CONTEXT_VERSION, "recording_id": source, "window_start": window_start,
               "cutoff": submitted, "segment_ids": []}
    if not source:
        if waited < s.judge_context_wait_seconds:
            raise tasks.Defer(10)
        return _write_insufficient(qid, q, context)
    segs, pending = select_context(source, submitted, s.context_window_seconds)
    if pending and waited < s.judge_context_wait_seconds:
        raise tasks.Defer(5)
    context["segment_ids"] = [x["id"] for x in segs]
    if not segs:
        return _write_insufficient(qid, q, context)

    event = get_event(q["event_id"])
    allowed = {norm_topic(t): t for t in event.get("topics", [])}
    # The judge never receives CV or identity: only question text and server-selected context.
    r = get_ai().evaluate_question(q["text"], segs, firebase.rfc3339(submitted), firebase.rfc3339(window_start),
                                   list(allowed.values()), event.get("locale", "sr"))
    topics = [t.model_dump() for t in r.topics if norm_topic(t.topic) in allowed]
    seg_ids = set(context["segment_ids"])
    judgment_ref(qid).set({
        "status": "done", "context_status": r.context_status, "relevance": r.relevance, "expertise": r.expertise,
        "depth": r.depth, "is_generic_clarification": r.is_generic_clarification, "topics": topics,
        "rationale": r.rationale.model_dump(), "source_segment_ids": [i for i in r.source_segment_ids if i in seg_ids],
        "context": context, "user_id": q["user_id"], "event_id": q["event_id"], "talk_id": q["talk_id"],
        "judged_at": firebase.now(), "model_id": r.model_id, "rubric_version": r.rubric_version})
    if r.context_status == "sufficient" and topics:
        profile_ref(q["event_id"], q["user_id"]).update(
            {"question_interests": gcf.ArrayUnion([allowed[norm_topic(t["topic"])] for t in topics])})


def fail_judge(payload: dict, error: str) -> None:
    q = question_ref(payload["question_id"]).get().to_dict()
    if q:
        judgment_ref(payload["question_id"]).set({"status": "failed", "error": error, "user_id": q["user_id"],
                                                  "event_id": q["event_id"], "talk_id": q["talk_id"]})


tasks.register("judge_question", run_judge, fail_judge)
