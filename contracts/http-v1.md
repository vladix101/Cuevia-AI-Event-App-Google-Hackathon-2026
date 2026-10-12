# Cuevia public HTTP contract v1

Owner: backend (Laptop 2). Changes require team agreement and a new versioned file (http-v2.md). Until then, v1 is binding.

```text
All JSON uses snake_case. IDs are opaque strings. submitted_at is RFC3339 UTC. Segment start_ms/end_ms are integer milliseconds relative to the recording; backend maps trusted sources into talk time. Do not confuse milliseconds with seconds.
Authenticate public requests with Authorization: Bearer <Firebase ID token>.
Standard error shape: {"error":{"code":"CODE","message":"human-readable","request_id":"opaque-id"}}.
Public responses NEVER include cv_baseline, expertise estimates, relevance, expertise, depth, quality, bonus, scores or rank.

Types:
Segment = {id:string,sequence:int,start_ms:int,end_ms:int,text:string,status:"ready"|"gap"}
Interest = {topic:string,source:"cv"|"question"|"declared"}
ProfilePublic = {user_id:string,cv_status:"missing"|"uploaded"|"processing"|"parsed"|"failed"|"removed",expertise_status:"N/A"|"estimated",interests:Interest[],eligible_for_top5:boolean}
QuestionPublic = {id:string,talk_id:string,text:string,submitted_at:string,read_status:"unread"|"read"}
Source = {id:string,title:string,url:string}
CatchUp = {cue:string,summary:string,source_segment_ids:string[],start_ms:int,end_ms:int}
Explanation = {explanation:string,example:string,sources:Source[],retrieval_mode:"web"|"provided"|"general"}

Routes:
GET /me -> {user_id,display_name,roles:string[]}
GET /events -> {items:[{id,title}],next_cursor:string|null}
POST /events/{event_id}/join -> {joined:true}
GET /events/{event_id}/talks -> {items:[{id,title,speaker_name,status:"scheduled"|"live"|"ended"}]}
GET /events/{event_id}/profile -> ProfilePublic
POST /events/{event_id}/cv multipart {file} -> 202 {cv_status:"processing"}
DELETE /events/{event_id}/cv -> ProfilePublic
PATCH /events/{event_id}/profile -> body {declared_interests:string[]} -> ProfilePublic; no client-written privileged scores
POST /talks/{talk_id}/recordings -> {recording_id:string,mode:"live"|"replay",started_at:string,sample_rate_hz:int,chunk_seconds:int}
POST /recordings/{recording_id}/chunks multipart {file,sequence,start_ms,end_ms} -> 202 {sequence:int,status:"accepted"}
GET /recordings/{recording_id}/segments?after_sequence=-1&limit=50 -> {items:Segment[],next_after_sequence:int,processing_lag_ms:int}
POST /recordings/{recording_id}/stop -> {status:"stopped"}
POST /recordings/{recording_id}/catch-up body {start_ms:int,end_ms:int} -> CatchUp
POST /recordings/{recording_id}/explanations body {selected_text:string,segment_id:string,depth:"simple"|"standard"|"advanced"} -> Explanation
GET /talks/{talk_id}/question-quota -> {used:int,limit:3,remaining:int}
GET /talks/{talk_id}/questions -> {items:QuestionPublic[]} belonging to authenticated attendee
POST /talks/{talk_id}/questions body {text:string,client_request_id:string} -> 201 {question:QuestionPublic,quota:{used:int,limit:3,remaining:int}}; repeated idempotent request returns same result, never consumes another slot
When the per-talk limit is exhausted, return 409 with code QUESTION_LIMIT_REACHED.
GET /speaker/events/{event_id}/questions -> {items:QuestionPublic[]} scoped to assigned talks
PATCH /speaker/questions/{question_id} body {read_status:"read"} -> QuestionPublic
GET /events/{event_id}/opportunities -> {items:[{id,recipient_id,recipient_kind:"sponsor"|"group",title,topics:string[]}]}
POST /sponsor/events/{event_id}/opportunities body {title,topics:string[],required_skills:string[]} -> {id:string}
PUT /events/{event_id}/consents/{recipient_id} body {allow_cv:boolean,allow_questions:boolean} -> {recipient_id,allow_cv,allow_questions}
GET /sponsor/events/{event_id}/recommendations -> {items:[{participant_id,display_name,interests:Interest[],reasons:string[],questions:QuestionPublic[],cv_available:boolean}]}; eligible, finalized and authorized recipients only; no hidden numeric scores
GET /sponsor/events/{event_id}/participants/{participant_id}/cv -> authorized file stream, checking current consent each time
POST /organizer/talks/{talk_id}/transcript-source body {recording_id:string} -> {configured:true}; trusted organizer-designated source only
POST /organizer/events/{event_id}/finalize-shortlists -> {snapshot_id:string,status:"finalized"}
GET /organizer/events/{event_id}/metrics -> {attendee_count:int,cv_parsed_count:int,na_count:int,question_count:int,catch_up_count:int,requested_terms:[{term,count}],interest_distribution:[{topic,count}],share_count:int}

For v1, poll segments around every 2 seconds while active; only append unseen sequence IDs. Poll CV status after upload until parsed/failed. Chat stores messages, never returns a generated answer.
```
