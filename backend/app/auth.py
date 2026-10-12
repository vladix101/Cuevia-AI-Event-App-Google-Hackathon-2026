"""Firebase ID-token verification and server-side authorization helpers.

Roles live in users/{uid} and are written only by trusted scripts (scripts/seed_demo.py);
no public route writes roles, organizer/speaker assignments or recipient membership.
"""
import threading
import time
from collections import defaultdict
from dataclasses import dataclass

from fastapi import Header
from firebase_admin import auth as fb_auth

from . import firebase
from .config import get_settings
from .errors import ApiError, forbidden, not_found


@dataclass(frozen=True)
class User:
    uid: str
    display_name: str
    roles: tuple[str, ...]


class _RateLimiter:
    """Fixed one-minute window per uid. In-memory: per instance only (documented MVP limitation)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._hits: dict[str, tuple[int, int]] = defaultdict(lambda: (0, 0))

    def check(self, key: str, limit: int) -> None:
        window = int(time.time() // 60)
        with self._lock:
            w, n = self._hits[key]
            n = n + 1 if w == window else 1
            self._hits[key] = (window, n)
        if n > limit:
            raise ApiError(429, "RATE_LIMITED", "Too many requests; slow down")


rate_limiter = _RateLimiter()


def current_user(authorization: str = Header(default="")) -> User:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise ApiError(401, "UNAUTHENTICATED", "Missing bearer token")
    try:
        claims = fb_auth.verify_id_token(token, app=firebase.app())
    except Exception:
        raise ApiError(401, "UNAUTHENTICATED", "Invalid or expired token") from None
    uid = claims["uid"]
    rate_limiter.check(uid, get_settings().rate_limit_per_minute)
    snap = firebase.db().collection("users").document(uid).get()
    data = snap.to_dict() if snap.exists else {}
    name = data.get("display_name") or claims.get("name") or claims.get("email") or uid
    roles = tuple(data.get("roles") or ["attendee"])
    return User(uid=uid, display_name=name, roles=roles)


def get_event(event_id: str) -> dict:
    snap = firebase.db().collection("events").document(event_id).get()
    if not snap.exists:
        raise not_found("Event")
    return {"id": snap.id, **snap.to_dict()}


def get_talk(talk_id: str) -> dict:
    snap = firebase.db().collection("talks").document(talk_id).get()
    if not snap.exists:
        raise not_found("Talk")
    return {"id": snap.id, **snap.to_dict()}


def is_member(event_id: str, uid: str) -> bool:
    return firebase.db().collection("events").document(event_id).collection("members").document(uid).get().exists


def require_member(event_id: str, user: User) -> dict:
    event = get_event(event_id)
    if not is_member(event_id, user.uid):
        raise forbidden("Join the event first")
    return event


def require_organizer(event_id: str, user: User) -> dict:
    event = get_event(event_id)
    if "organizer" not in user.roles or user.uid not in event.get("organizer_uids", []):
        raise forbidden("Organizer access required")
    return event


def require_speaker_talk_ids(event_id: str, user: User) -> list[str]:
    get_event(event_id)
    if "speaker" not in user.roles:
        raise forbidden("Speaker access required")
    talks = (
        firebase.db().collection("talks")
        .where("event_id", "==", event_id)
        .where("speaker_uids", "array_contains", user.uid)
        .stream()
    )
    return [t.id for t in talks]


def sponsor_recipient_ids(event_id: str, user: User) -> list[str]:
    """Recipients (sponsor organisations or groups) this user acts for in the event."""
    if "sponsor" not in user.roles:
        raise forbidden("Sponsor access required")
    get_event(event_id)
    docs = (
        firebase.db().collection("recipients")
        .where("event_id", "==", event_id)
        .where("member_uids", "array_contains", user.uid)
        .stream()
    )
    ids = [d.id for d in docs]
    if not ids:
        raise forbidden("No sponsor organisation assigned for this event")
    return ids
