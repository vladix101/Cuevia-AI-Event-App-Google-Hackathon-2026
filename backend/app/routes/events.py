import io
import logging

from fastapi import APIRouter, Depends, Query, UploadFile

from .. import blobs, firebase, tasks
from ..ai_client import get_ai
from ..auth import User, current_user, get_event, require_member
from ..config import get_settings
from ..errors import ApiError, bad_request
from ..policy import has_known_baseline, norm_topic
from ..schemas import (CvAccepted, EventItem, EventList, Interest, Joined, Me, ProfilePatch,
                       ProfilePublic, TalkItem, TalkList)

router = APIRouter()
log = logging.getLogger("cuevia.profile")

MAX_CV_TEXT = 30_000
MAX_INTERESTS = 20
CV_TYPES = {
    "application/pdf": ("pdf", b"%PDF"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ("docx", b"PK\x03\x04"),
}


def profile_id(event_id: str, uid: str) -> str:
    return f"{event_id}_{uid}"


def profile_ref(event_id: str, uid: str):
    return firebase.db().collection("profiles").document(profile_id(event_id, uid))


def private_profile_ref(event_id: str, uid: str):
    """Internal-only document: CV baselines, skills, model ids. Never serialized to browsers."""
    return firebase.db().collection("private_profiles").document(profile_id(event_id, uid))


def _clean_topics(values, limit=MAX_INTERESTS) -> list[str]:
    seen, out = set(), []
    for v in values or []:
        t = " ".join(str(v).split())[:60]
        if t and norm_topic(t) not in seen:
            seen.add(norm_topic(t))
            out.append(t)
    return out[:limit]


def public_interests(p: dict) -> list[Interest]:
    out, seen = [], set()
    for source, key in (("declared", "declared_interests"), ("cv", "cv_interests"), ("question", "question_interests")):
        for t in p.get(key, []):
            if norm_topic(t) not in seen:
                seen.add(norm_topic(t))
                out.append(Interest(topic=t, source=source))
    return out


def baselines_of(private: dict | None) -> dict[str, float | None]:
    return dict((private or {}).get("baselines", {}))


def project_profile(event_id: str, uid: str) -> ProfilePublic:
    p = profile_ref(event_id, uid).get().to_dict() or {"cv_status": "missing"}
    estimated = False
    if p.get("cv_status") == "parsed":
        estimated = has_known_baseline(baselines_of(private_profile_ref(event_id, uid).get().to_dict()))
    return ProfilePublic(user_id=uid, cv_status=p.get("cv_status", "missing"),
                         expertise_status="estimated" if estimated else "N/A",
                         interests=public_interests(p), eligible_for_top5=estimated)


@router.get("/me", response_model=Me)
def me(user: User = Depends(current_user)):
    return Me(user_id=user.uid, display_name=user.display_name, roles=list(user.roles))


@router.get("/events", response_model=EventList)
def list_events(cursor: str | None = Query(default=None, max_length=128),
                limit: int = Query(default=20, ge=1, le=50), user: User = Depends(current_user)):
    q = firebase.db().collection("events").order_by("__name__").limit(limit + 1)
    if cursor:
        q = q.start_after(firebase.db().collection("events").document(cursor).get())
    docs = list(q.stream())
    items = [EventItem(id=d.id, title=d.get("title")) for d in docs[:limit]]
    return EventList(items=items, next_cursor=items[-1].id if len(docs) > limit else None)


@router.post("/events/{event_id}/join", response_model=Joined)
def join(event_id: str, user: User = Depends(current_user)):
    get_event(event_id)
    db = firebase.db()
    member = db.collection("events").document(event_id).collection("members").document(user.uid)
    if not member.get().exists:
        member.set({"joined_at": firebase.now()})
    pref = profile_ref(event_id, user.uid)
    if not pref.get().exists:
        pref.set({"event_id": event_id, "user_id": user.uid, "cv_status": "missing", "cv_version": 0,
                  "cv_interests": [], "question_interests": [], "declared_interests": []})
    return Joined()


@router.get("/events/{event_id}/talks", response_model=TalkList)
def talks(event_id: str, user: User = Depends(current_user)):
    require_member(event_id, user)
    docs = firebase.db().collection("talks").where("event_id", "==", event_id).stream()
    items = [TalkItem(id=d.id, title=d.get("title"), speaker_name=d.get("speaker_name"),
                      status=d.get("status")) for d in docs]
    items.sort(key=lambda t: t.id)
    return TalkList(items=items)


@router.get("/events/{event_id}/profile", response_model=ProfilePublic)
def get_profile(event_id: str, user: User = Depends(current_user)):
    require_member(event_id, user)
    return project_profile(event_id, user.uid)


@router.patch("/events/{event_id}/profile", response_model=ProfilePublic)
def patch_profile(event_id: str, body: ProfilePatch, user: User = Depends(current_user)):
    require_member(event_id, user)
    profile_ref(event_id, user.uid).update({"declared_interests": _clean_topics(body.declared_interests)})
    return project_profile(event_id, user.uid)


@router.post("/events/{event_id}/cv", response_model=CvAccepted, status_code=202)
def upload_cv(event_id: str, file: UploadFile, user: User = Depends(current_user)):
    require_member(event_id, user)
    s = get_settings()
    kind = CV_TYPES.get(file.content_type or "")
    data = file.file.read(s.max_cv_bytes + 1)
    if kind is None or not data.startswith(kind[1]):
        raise ApiError(415, "UNSUPPORTED_FILE", "CV must be a PDF or DOCX file")
    if len(data) > s.max_cv_bytes:
        raise ApiError(413, "FILE_TOO_LARGE", f"CV must be at most {s.max_cv_bytes} bytes")

    pref = profile_ref(event_id, user.uid)

    def bump(tx):
        version = ((pref.get(transaction=tx).to_dict() or {}).get("cv_version") or 0) + 1
        blob = f"cvs/{event_id}/{user.uid}/{version}.{kind[0]}"
        tx.update(pref, {"cv_status": "processing", "cv_version": version, "cv_blob": blob,
                         "cv_content_type": file.content_type, "cv_interests": []})
        return version, blob

    version, blob = firebase.run_transaction(bump)
    blobs.put(blob, data, file.content_type)
    tasks.enqueue(f"cv_{event_id}_{user.uid}_{version}", "cv_profile",
                  {"event_id": event_id, "user_id": user.uid, "cv_version": version})
    return CvAccepted()


@router.delete("/events/{event_id}/cv", response_model=ProfilePublic)
def delete_cv(event_id: str, user: User = Depends(current_user)):
    require_member(event_id, user)
    pref = profile_ref(event_id, user.uid)
    p = pref.get().to_dict() or {}
    # Bumping the version invalidates any in-flight processing task for the old file.
    pref.update({"cv_status": "removed", "cv_version": (p.get("cv_version") or 0) + 1, "cv_blob": None,
                 "cv_content_type": None, "cv_interests": []})
    private_profile_ref(event_id, user.uid).delete()
    if p.get("cv_blob"):
        blobs.delete(p["cv_blob"])
    return project_profile(event_id, user.uid)


# ---------- background CV processing ----------

def extract_cv_text(data: bytes, content_type: str) -> str:
    kind = CV_TYPES[content_type][0]
    if kind == "pdf":
        import pymupdf
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            text = "\n".join(page.get_text() for page in doc)
    else:
        import docx
        d = docx.Document(io.BytesIO(data))
        text = "\n".join(p.text for p in d.paragraphs)
    return " ".join(text.split())[:MAX_CV_TEXT]


def _current(payload: dict) -> dict | None:
    p = profile_ref(payload["event_id"], payload["user_id"]).get().to_dict()
    if not p or p.get("cv_version") != payload["cv_version"] or p.get("cv_status") != "processing":
        return None  # superseded by a newer upload or removal
    return p


def run_cv_profile(payload: dict) -> None:
    p = _current(payload)
    if p is None:
        return
    eid, uid = payload["event_id"], payload["user_id"]
    data = blobs.get(p["cv_blob"])
    try:
        text = extract_cv_text(data, p["cv_content_type"])
    except Exception:
        text = ""
    if len(text) < 50:
        profile_ref(eid, uid).update({"cv_status": "failed"})
        return
    result = get_ai().profile(text, get_event(eid).get("topics", []))
    if _current(payload) is None:
        return
    baselines = {norm_topic(t.topic): t.baseline for t in result.topic_estimates}
    private_profile_ref(eid, uid).set({
        "cv_version": payload["cv_version"], "baselines": baselines,
        "topic_estimates": [t.model_dump() for t in result.topic_estimates],
        "skills": [s.model_dump() for s in result.skills][:50], "model_id": result.model_id,
        "updated_at": firebase.now()})
    profile_ref(eid, uid).update({"cv_status": "parsed", "cv_interests": _clean_topics(result.interests)})


def fail_cv_profile(payload: dict, error: str) -> None:
    if _current(payload) is not None:
        profile_ref(payload["event_id"], payload["user_id"]).update({"cv_status": "failed"})


tasks.register("cv_profile", run_cv_profile, fail_cv_profile)
