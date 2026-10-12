# Cuevia

Hackathon MVP for the problem: *"Conferences struggle to keep attendees engaged and connect them with relevant professional opportunities."*

Attendees get live phone transcription, "Izgubio sam nit" catch-up, personalized term explanations and a
"Postavi pitanje" drawer that stores up to three questions per talk for the speaker (no AI replies).
Gemma privately rates questions; at event end, sponsors see up to five consenting, eligible profiles per
opportunity. Humans decide whom to contact.

```
Browser (frontend/, Firebase Auth) ──REST──▶ backend/ (FastAPI, Firestore) ──X-Internal-Token──▶ ai/ (Gemma only)
        http://localhost:5173               http://localhost:8000/api/v1                     http://localhost:8001/internal/v1
```

| Path | Owner | Notes |
|---|---|---|
| `frontend/` | Laptop 1 | Vite app; only gets `VITE_API_BASE_URL` + public Firebase config |
| `backend/`, `infra/`, `contracts/`, `integration/`, root config | Laptop 2 | Public API, persistence, policy, integration |
| `ai/` | Laptop 3 | Private Gemma service, prompts, optional audio |

Contracts: [`contracts/http-v1.md`](contracts/http-v1.md) (public) and [`contracts/ai-v1.md`](contracts/ai-v1.md) (private).
Changing either needs team agreement and a new versioned file.

## Backend quick start (Windows)

Runs against the real Firebase project `hakaton-47939` on the free **Spark plan (no card)**: Firestore + Auth only.
There is no Cloud Storage bucket; CV and audio files are stored in Firestore (`backend/app/blobs.py`).

```bash
cd backend
py -3.13 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
cp .env.example .env    # set FIREBASE_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS=service-account.json, AI_SERVICE_TOKEN
# service-account.json: Firebase console -> Project settings -> Service accounts -> Generate new private key
#   (never commit it; .gitignore excludes it)

.venv/Scripts/python -m scripts.seed_demo --password <choose-one>   # trusted script: demo users, roles, event
.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

Seeded accounts (`<uid>@demo.cuevia.test`): `organizer`, `speaker`, `sponsor`, `attendee1`, `attendee2`; event
`demo-event` with talks `talk-ml`, `talk-sec`, recipients `acme` (sponsor) and `ml-group` (group).

`GET http://localhost:8000/healthz` reports `ai_available`; the public API keeps working when AI is down and
AI-dependent work stays pending or returns `503 AI_UNAVAILABLE` — no output is invented.

Spark quota notes: 50k reads / 20k writes / 1 GiB per day. Audio is deleted right after transcription (the transcript
text is kept); the worker polls every 15 s (new work wakes it immediately) to stay well inside the read quota.

Full stack in containers (after `frontend/` and `ai/` provide Dockerfiles and `.env` files exist): `docker compose up --build`.

## Tests

```bash
backend/.venv/Scripts/python -m pytest integration -q          # contract checks, no Firebase access
AI_SERVICE_TOKEN=... backend/.venv/Scripts/python integration/smoke_ai.py   # live private-AI smoke
```

`backend/tests` (unit + API tests) **wipe the whole database and all Auth users** before every test, so they are pinned
to the local Firebase emulators and must never run against `hakaton-47939`:
`firebase emulators:exec --config ../firebase.json --project demo-cuevia --only auth,firestore ".venv\Scripts\python -m pytest -q"`.
They use a **deterministic AI fixture** (`backend/tests/fake_ai.py`, `model_id="test-fixture-not-a-model"`) injected via
`httpx.MockTransport`; runtime code never imports it.

## How the backend enforces the rules

- **Auth**: every request verifies the Firebase ID token server-side. Roles live in `users/{uid}` and are written only by
  `scripts/seed_demo.py`; organizer/speaker/sponsor rights are additionally scoped per event/talk/recipient.
  Firestore rules (`infra/firestore.rules`) deny all direct client access — the browser uses REST only (v1).
- **Private vs public data**: CV baselines live in `private_profiles`, AI ratings in `question_judgments`, rankings in
  `snapshots`. Public response models forbid extra fields; tests assert no score keys appear in API responses or in the
  attendee-facing `profiles` / `questions` documents.
- **Questions**: persisted and acknowledged before judging. Quota is a Firestore transaction; the question id is a hash of
  `(talk, user, client_request_id)`, so retries return the same result and concurrent requests cannot get a fourth slot.
- **Judging**: only the organizer-designated transcript recording (organizer's or the talk speaker's) is trusted. Context is
  segments that *ended* within the 180 s before server `submitted_at` — never future speech or client choices. The cutoff,
  window and segment ids are frozen on the judgment. No source / no segments → `insufficient`, no scores. The judge never
  receives CV text or identity.
- **Policy** (`app/policy.py`, configurable via env): good question = sufficient context, relevance ≥ 6, expertise + depth > 0
  (generic clarifications forced to 0/0). `quality = (r+e+d)/3`; topic bonus = max good quality for the topic, capped at 10;
  estimate = `min(100, cv_baseline + bonus)`, unknown baseline stays unknown. Bonuses are recomputed from all judgments, so
  re-evaluation replaces rather than double-adds and nothing ever subtracts.
- **Shortlists**: per opportunity, candidates need a parsed CV, a known baseline in an opportunity topic and current
  `allow_cv` consent for that recipient. Order: best relevant estimate ↓, relevant coverage ↓, participant id ↑ (`rank-v1`).
  AI `/match` only writes reasons; if it is down, reasons are plain CV facts. Snapshots are versioned, and every
  recommendations/CV request re-checks current consent and CV status, so withdrawal or CV removal takes effect immediately.
  CV files are streamed with `Cache-Control: no-store`; no public URLs (files live in private Firestore docs).
- **Background work** (CV parsing, transcription, judging) is a Firestore task queue with leases and bounded retries;
  tasks interrupted by a crash are reclaimed after the lease expires. Terminal failures become honest states
  (`cv_status=failed`, segment `status=gap`, judgment `failed`).

## Deployment notes (not performed automatically)

- **Backend → Cloud Run**: `gcloud run deploy cuevia-api --source backend --region europe-west1` with the runtime service
  account (ADC; no key file), env from `.env.example` minus emulator vars, `CORS_ORIGINS` set to the Hosting origin.
  The in-process worker needs CPU outside requests: use `--no-cpu-throttling --min-instances=1`. Multiple instances are
  safe (tasks are claimed transactionally), but the rate limiter is in-memory per instance.
- **AI service → Cloud Run** with `--no-allow-unauthenticated` (or internal ingress) so only the backend can reach it;
  `X-Internal-Token` alone is an MVP measure, not a production boundary.
- **Frontend → Firebase Hosting**: `firebase deploy --only hosting` serves `frontend/dist` (see `firebase.json`).
- **Rules/indexes**: `firebase deploy --only firestore:rules,firestore:indexes`.

## Known MVP limitations

- Rate limiting is per-instance and in memory.
- Files live in Firestore (Spark plan, no Storage bucket): max 5 MB CV, 1 GiB total free quota.
- `recipient_kind: "group"` recipients are created by the seed script; there is no group-management API in v1.
- CV/question-derived expertise and AI ratings are advisory estimates, not verified knowledge or hiring decisions.
