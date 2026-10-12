import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from .. import blobs, firebase
from ..auth import User, current_user, get_event, require_member, sponsor_recipient_ids
from ..errors import forbidden, not_found
from ..schemas import (Consent, ConsentBody, Created, Opportunity, OpportunityCreate, OpportunityList,
                       Recommendation, RecommendationList)
from .events import _clean_topics, profile_ref, public_interests
from .questions import question_ref, to_public

router = APIRouter()


def consent_ref(event_id: str, uid: str, recipient_id: str):
    return firebase.db().collection("consents").document(f"{event_id}_{uid}_{recipient_id}")


def current_consent(event_id: str, uid: str, recipient_id: str) -> dict:
    snap = consent_ref(event_id, uid, recipient_id).get()
    return snap.to_dict() if snap.exists else {"allow_cv": False, "allow_questions": False}


def cv_shareable(event_id: str, uid: str, recipient_id: str) -> tuple[bool, dict, dict]:
    """Current (not snapshot-time) check: consent to this recipient AND a currently parsed CV."""
    consent = current_consent(event_id, uid, recipient_id)
    profile = profile_ref(event_id, uid).get().to_dict() or {}
    ok = bool(consent.get("allow_cv")) and profile.get("cv_status") == "parsed" and bool(profile.get("cv_blob"))
    return ok, consent, profile


def current_snapshot(event_id: str) -> dict | None:
    sid = get_event(event_id).get("current_snapshot_id")
    if not sid:
        return None
    snap = firebase.db().collection("snapshots").document(sid).get()
    return snap.to_dict() if snap.exists else None


@router.get("/events/{event_id}/opportunities", response_model=OpportunityList)
def list_opportunities(event_id: str, user: User = Depends(current_user)):
    require_member(event_id, user)
    docs = firebase.db().collection("opportunities").where("event_id", "==", event_id).stream()
    items = [Opportunity(id=d.id, recipient_id=d.get("recipient_id"), recipient_kind=d.get("recipient_kind"),
                         title=d.get("title"), topics=d.get("topics")) for d in docs]
    items.sort(key=lambda o: o.id)
    return OpportunityList(items=items)


@router.post("/sponsor/events/{event_id}/opportunities", response_model=Created)
def create_opportunity(event_id: str, body: OpportunityCreate, user: User = Depends(current_user)):
    recipient_id = sponsor_recipient_ids(event_id, user)[0]
    recipient = firebase.db().collection("recipients").document(recipient_id).get().to_dict()
    oid = uuid.uuid4().hex
    firebase.db().collection("opportunities").document(oid).set({
        "event_id": event_id, "recipient_id": recipient_id, "recipient_kind": recipient["kind"],
        "title": " ".join(body.title.split()), "topics": _clean_topics(body.topics, 10),
        "required_skills": _clean_topics(body.required_skills), "created_by": user.uid, "created_at": firebase.now()})
    return Created(id=oid)


@router.put("/events/{event_id}/consents/{recipient_id}", response_model=Consent)
def put_consent(event_id: str, recipient_id: str, body: ConsentBody, user: User = Depends(current_user)):
    require_member(event_id, user)
    r = firebase.db().collection("recipients").document(recipient_id).get()
    if not r.exists or r.get("event_id") != event_id:
        raise not_found("Recipient")
    consent_ref(event_id, user.uid, recipient_id).set({
        "event_id": event_id, "user_id": user.uid, "recipient_id": recipient_id,
        "allow_cv": body.allow_cv, "allow_questions": body.allow_questions, "updated_at": firebase.now()})
    return Consent(recipient_id=recipient_id, allow_cv=body.allow_cv, allow_questions=body.allow_questions)


def _display_name(uid: str) -> str:
    snap = firebase.db().collection("users").document(uid).get()
    return (snap.to_dict() or {}).get("display_name") or "Učesnik"


@router.get("/sponsor/events/{event_id}/recommendations", response_model=RecommendationList)
def recommendations(event_id: str, user: User = Depends(current_user)):
    recipients = set(sponsor_recipient_ids(event_id, user))
    snapshot = current_snapshot(event_id)
    if snapshot is None:
        return RecommendationList(items=[])
    merged: dict[str, Recommendation] = {}
    for entry in snapshot["entries"]:
        if entry["recipient_id"] not in recipients:
            continue
        pid = entry["participant_id"]
        ok, consent, profile = cv_shareable(event_id, pid, entry["recipient_id"])
        if not ok:  # consent withdrawn or CV removed since finalization
            continue
        questions = []
        if consent.get("allow_questions"):
            for qid in entry["question_ids"]:
                q = question_ref(qid).get()
                if q.exists and q.get("user_id") == pid:
                    questions.append(to_public(qid, q.to_dict()))
        rec = merged.get(pid)
        if rec is None:
            merged[pid] = Recommendation(participant_id=pid, display_name=_display_name(pid),
                                         interests=public_interests(profile), reasons=list(entry["reasons"]),
                                         questions=questions, cv_available=True)
        else:
            rec.reasons += [r for r in entry["reasons"] if r not in rec.reasons]
            rec.questions += [q for q in questions if q.id not in {x.id for x in rec.questions}]
    return RecommendationList(items=list(merged.values()))


@router.get("/sponsor/events/{event_id}/participants/{participant_id}/cv")
def download_cv(event_id: str, participant_id: str, user: User = Depends(current_user)):
    recipients = set(sponsor_recipient_ids(event_id, user))
    snapshot = current_snapshot(event_id) or {"entries": []}
    shortlisted_for = {e["recipient_id"] for e in snapshot["entries"]
                       if e["participant_id"] == participant_id and e["recipient_id"] in recipients}
    for rid in sorted(shortlisted_for):
        ok, _, profile = cv_shareable(event_id, participant_id, rid)
        if ok:
            data = blobs.get(profile["cv_blob"])
            ext = profile["cv_blob"].rsplit(".", 1)[-1]
            return Response(data, media_type=profile["cv_content_type"], headers={
                "Content-Disposition": f'attachment; filename="cv-{participant_id}.{ext}"',
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    raise forbidden("No current consent to share this CV")
