"""Trusted local provisioning of demo data and privileged users (organizer/speaker/sponsor).

Roles are written here with Admin credentials and never through the public API.
Usage (emulators):  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
                    python -m scripts.seed_demo --password demo-pass-123
Against a real project, set GOOGLE_APPLICATION_CREDENTIALS/FIREBASE_PROJECT_ID and choose a strong password.
"""
import argparse

from firebase_admin import auth as fb_auth

from app import firebase

USERS = [
    ("organizer", "Organizator", ["organizer"]),
    ("speaker", "Govornik", ["speaker"]),
    ("sponsor", "Sponzor Acme", ["sponsor"]),
    ("attendee1", "Ana Petrović", ["attendee"]),
    ("attendee2", "Marko Jovanović", ["attendee"]),
]


def ensure_user(uid: str, name: str, roles: list[str], password: str, domain: str) -> None:
    email = f"{uid}@{domain}"
    try:
        fb_auth.get_user(uid, app=firebase.app())
        fb_auth.update_user(uid, email=email, password=password, display_name=name, app=firebase.app())
    except fb_auth.UserNotFoundError:
        fb_auth.create_user(uid=uid, email=email, password=password, display_name=name, app=firebase.app())
    firebase.db().collection("users").document(uid).set({"display_name": name, "roles": roles})
    print(f"  {email:32} roles={roles}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--password", required=True, help="password for all demo accounts")
    p.add_argument("--domain", default="demo.cuevia.test")
    p.add_argument("--event-id", default="demo-event")
    a = p.parse_args()
    db = firebase.db()
    print("Users:")
    for uid, name, roles in USERS:
        ensure_user(uid, name, roles, a.password, a.domain)
    db.collection("events").document(a.event_id).set({
        "title": "Cuevia Demo Konferencija", "topics": ["Machine Learning", "Cloud", "Security", "Data Engineering"],
        "organizer_uids": ["organizer"], "locale": "sr"}, merge=True)
    for tid, title, status in [("talk-ml", "Transformeri u praksi", "live"), ("talk-sec", "Zero trust", "scheduled")]:
        db.collection("talks").document(tid).set({
            "event_id": a.event_id, "title": title, "speaker_name": "Govornik", "speaker_uids": ["speaker"],
            "status": status}, merge=True)
    db.collection("recipients").document("acme").set(
        {"event_id": a.event_id, "kind": "sponsor", "name": "Acme", "member_uids": ["sponsor"]})
    db.collection("recipients").document("ml-group").set(
        {"event_id": a.event_id, "kind": "group", "name": "ML zajednica", "member_uids": []})
    for uid in ("organizer", "speaker"):
        db.collection("events").document(a.event_id).collection("members").document(uid).set(
            {"joined_at": firebase.now()})
    print(f"Event {a.event_id} with talks talk-ml, talk-sec and recipients acme, ml-group seeded.")


if __name__ == "__main__":
    main()
