"""Tests run against the Firebase emulators (Auth, Firestore) — real transactions and real
ID-token verification. Start them with:  firebase emulators:exec --only auth,firestore "pytest"
Never point tests at a real project: every test wipes the whole database and all Auth users.
"""
import os
import uuid

os.environ.setdefault("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")
os.environ.setdefault("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")
os.environ["GCLOUD_PROJECT"] = os.environ["FIREBASE_PROJECT_ID"] = "demo-cuevia"
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = ""  # never load the real service account in tests
os.environ["AI_SERVICE_TOKEN"] = "test-internal-token"
os.environ["WORKER_ENABLED"] = "false"
os.environ["JUDGE_CONTEXT_WAIT_SECONDS"] = "0"
os.environ["RATE_LIMIT_PER_MINUTE"] = "10000"

import httpx
import pytest
from fastapi.testclient import TestClient
from firebase_admin import auth as fb_auth

from app import ai_client, firebase, tasks
from app.config import get_settings
from app.main import app
from tests.fake_ai import FakeAI

PROJECT = "demo-cuevia"
FS = os.environ["FIRESTORE_EMULATOR_HOST"]
AUTH = os.environ["FIREBASE_AUTH_EMULATOR_HOST"]


@pytest.fixture(autouse=True)
def clean_emulators():
    httpx.delete(f"http://{FS}/emulator/v1/projects/{PROJECT}/databases/(default)/documents").raise_for_status()
    httpx.delete(f"http://{AUTH}/emulator/v1/projects/{PROJECT}/accounts").raise_for_status()
    yield


@pytest.fixture
def ai():
    fake = FakeAI()
    ai_client.set_ai(ai_client.AIClient(transport=fake.transport()))
    yield fake
    ai_client.set_ai(None)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def settings():
    s = get_settings()
    saved = s.model_dump()
    yield s
    for k, v in saved.items():
        setattr(s, k, v)


def make_user(uid: str, roles=("attendee",), name=None) -> dict:
    """Creates a real emulator Auth user and returns Authorization headers with a real ID token."""
    email = f"{uid}@test.cuevia"
    fb_auth.create_user(uid=uid, email=email, password="secret123", app=firebase.app())
    firebase.db().collection("users").document(uid).set({"display_name": name or uid, "roles": list(roles)})
    r = httpx.post(f"http://{AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake",
                   json={"email": email, "password": "secret123", "returnSecureToken": True})
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['idToken']}"}


@pytest.fixture
def world(client):
    """Event with one talk, organizer, speaker, sponsor org and two attendees (joined)."""
    db = firebase.db()
    h = {
        "org": make_user("org", ("organizer",)),
        "spk": make_user("spk", ("speaker",)),
        "sp": make_user("sp", ("sponsor",)),
        "a1": make_user("a1", name="Ana"),
        "a2": make_user("a2", name="Bojan"),
    }
    db.collection("events").document("ev1").set(
        {"title": "AI Konf", "topics": ["Machine Learning", "Cloud"], "organizer_uids": ["org"], "locale": "sr"})
    db.collection("talks").document("t1").set(
        {"event_id": "ev1", "title": "Transformeri", "speaker_name": "Speaker", "speaker_uids": ["spk"], "status": "live"})
    db.collection("recipients").document("acme").set(
        {"event_id": "ev1", "kind": "sponsor", "name": "Acme", "member_uids": ["sp"]})
    for who in ("a1", "a2", "org", "spk"):
        assert client.post("/api/v1/events/ev1/join", headers=h[who]).status_code == 200
    return h


def drain():
    while tasks.run_pending_once():
        pass


def new_id() -> str:
    return uuid.uuid4().hex
