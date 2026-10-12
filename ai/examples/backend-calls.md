# Example private calls (for the backend owner)

Base URL: `http://localhost:8001/internal/v1`. Every route except `/health` needs
`X-Internal-Token: $AI_SERVICE_TOKEN`. Errors always use
`{"error":{"code":"...","message":"...","request_id":"..."}}`; you can pass `X-Request-ID` to
correlate logs (it is echoed back).

Responses below are **real outputs** from the first smoke run (local `gemma4:e2b`, 2026-10-11),
lightly truncated. The service now runs on hosted `gemma-4-26b-a4b-it` by default, so `model_id`
will read `gemma-4-26b-a4b-it`. Inputs are the synthetic fixtures in `ai/tests/fixtures/`.
With hosted Gemma only, `/transcribe` returns 503 `AUDIO_UNAVAILABLE` (hosted Gemma 4 has no audio input).

## Health

```bash
curl -s http://localhost:8001/internal/v1/health
# {"status":"ok","service":"cuevia-ai","contract_version":"1"}
```

## /evaluate-question

The backend selects the authoritative-transcript segments for the 180 s before the server-side
`submitted_at`. Send **no** user id, name, CV or role: extra fields are rejected with 422.

```bash
curl -s -X POST http://localhost:8001/internal/v1/evaluate-question \
  -H "X-Internal-Token: $AI_SERVICE_TOKEN" -H "Content-Type: application/json" -d '{
  "question_text": "Kako HNSW indeks podnosi česta brisanja dokumenata, da li tombstone zapisi vremenom kvare recall dok se indeks ponovo ne izgradi?",
  "segments": [
    {"id":"seg-004","sequence":3,"start_ms":45000,"end_ms":60000,"text":"Za brzu pretragu koristimo približnu pretragu najbližih suseda, na primer HNSW indeks, koji menja malo tačnosti za mnogo brzine.","status":"ready"},
    {"id":"seg-005","sequence":4,"start_ms":60000,"end_ms":75000,"text":"Parametar ef_search određuje koliko kandidata pregledamo. Veći ef_search znači bolji recall ali veću latenciju.","status":"ready"}
  ],
  "submitted_at": "2026-10-10T18:03:00Z",
  "window_start_at": "2026-10-10T18:00:00Z",
  "allowed_topics": ["Vector databases", "Machine learning", "Search latency"],
  "context_available": true,
  "locale": "sr"
}'
```

```json
{"relevance":9.0,"expertise":8.0,"depth":8.0,
 "topics":[{"topic":"Vector databases","evidence":"Kako HNSW indeks podnosi česta brisanja dokumenata, ...","confidence":"high"}],
 "rationale":{"relevance":"The question directly addresses ...","expertise":"...","depth":"..."},
 "source_segment_ids":["seg-004","seg-005","seg-006"],"context_status":"sufficient",
 "is_generic_clarification":false,"model_id":"gemma4:e2b","rubric_version":"question-rubric-v1"}
```

Backend notes:
* `context_available=false` (or too little ready text) → `context_status:"insufficient"` and
  `relevance/expertise/depth: null`. Treat null as "no evidence", never as a penalty.
* Generic repeat/clarify questions → `is_generic_clarification:true`, `expertise:0`, `depth:0`.
  If there is no context too, no model is called and `model_id` is `"rule:generic-clarification"`.
* `window_start_at` must be 0–180 s (+5 s tolerance) before `submitted_at`, otherwise 422 `INVALID_WINDOW`.
* Any 5xx/502 = model failure → store no evidence (never subtract).

## /profile

```json
POST /profile
{"cv_text":"<extracted CV text, max 60k chars>","event_topics":["Vector databases","Machine learning","Frontend development"]}
```
```json
{"skills":[{"name":"Python","evidence":"Veštine: Python, FastAPI, PostgreSQL, pgvector, Docker, Kubernetes osnove."}, "..."],
 "topic_estimates":[
   {"topic":"Vector databases","baseline":80.0,"uncertainty":"low","evidence":["Implementirala semantičku pretragu nad 2 miliona dokumenata ..."]},
   {"topic":"Frontend development","baseline":null,"uncertainty":"high","evidence":[]}],
 "interests":["Vector databases","PostgreSQL","pgvector"],"model_id":"gemma4:e2b"}
```
Every evidence string is verified to be a quote from `cv_text`; unsupported topics are `null`.
Text extraction from PDF/DOCX is the backend's job (the AI service takes plain text only).

## /catch-up

```json
POST /catch-up
{"segments":[<Segment>...],"locale":"sr"}
→ {"cue":"Vektorske baze podataka","summary":"...","source_segment_ids":["seg-001","seg-002","seg-004"],"model_id":"gemma4:e2b"}
```
`start_ms`/`end_ms` of the public `CatchUp` are computed by the backend from the returned ids.
No ready segments → 422 `NO_TRANSCRIPT`.

## /explain

```json
POST /explain
{"term":"HNSW","segments":[<Segment>...],"depth":"simple","locale":"sr",
 "background":[{"topic":"Vector databases","baseline":20,"uncertainty":"medium","evidence":[]}],
 "provided_sources":[{"id":"src-pgvector","title":"pgvector README","url":"https://github.com/pgvector/pgvector"}]}
→ {"explanation":"HNSW je tehnika indeksa ...","example":"...",
   "sources":[{"id":"src-pgvector","title":"pgvector README","url":"https://github.com/pgvector/pgvector"}],
   "retrieval_mode":"provided","model_id":"gemma4:e2b"}
```
Web sources get ids `web-1..web-5`. Unsafe/private URLs in `provided_sources` are dropped.

## /match

```json
POST /match
{"opportunity":{"id":"opp-1","title":"Search Platform Engineer","topics":["Vector databases"],"required_skills":["Python","pgvector","Rust"]},
 "profile_evidence":{"skills":[{"name":"pgvector","evidence":"..."}],"interests":["Vector databases"]},
 "questions":[{"text":"Kako HNSW indeks podnosi česta brisanja dokumenata?","topics":["Vector databases"]},
              {"text":"Gde je parking za posetioce?","topics":[]}]}
→ {"reasons":["The attendee has direct experience with pgvector for semantic search over millions of documents, matching a key topic."],
   "missing_requirements":["Rust"],"supported_question_indices":[0],"model_id":"gemma4:e2b"}
```

## /transcribe

```bash
curl -s -X POST http://localhost:8001/internal/v1/transcribe \
  -H "X-Internal-Token: $AI_SERVICE_TOKEN" -F "file=@chunk.wav" -F "language=sr"
# {"text":"...","model_id":"gemma4:e2b"}
```
* Max 30 s and 10 MB per chunk (configurable). Send 16 kHz mono PCM WAV ideally; any PCM WAV is
  down-mixed/resampled. webm/ogg/mp3 need ffmpeg (present in the Docker image).
* Silence → `{"text":""}`. Audio not configured → 503 `AUDIO_UNAVAILABLE` (no fallback ASR).
