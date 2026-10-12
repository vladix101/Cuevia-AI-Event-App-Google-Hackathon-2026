# Cuevia private AI contract v1

Owner: backend (Laptop 2) maintains this file; ai/ owns its Pydantic implementation, backend/ owns the matching client models. Changes require team agreement and a new versioned file (ai-v2.md).

```text
AI service owns its Pydantic definitions under ai/. Backend owns matching internal-client definitions under backend/. Compare both against this fixed contract. No shared package dependency is required.
Private AI has no authority to set roles, question quotas, sharing grants or final rankings. Backend passes bounded authorized context and applies deterministic policy.

TopicEvidence = {topic:string,baseline:number|null,uncertainty:"low"|"medium"|"high",evidence:string[]}; baseline is 0-100 if supported, null if insufficient.
AIQuestionEvaluation = {
 relevance:number|null, expertise:number|null, depth:number|null,
 topics:[{topic:string,evidence:string,confidence:"low"|"medium"|"high"}],
 rationale:{relevance:string,expertise:string,depth:string},
 source_segment_ids:string[],context_status:"sufficient"|"insufficient",
 is_generic_clarification:boolean,model_id:string,rubric_version:string
}
Three numeric criteria must be 0-10 when context_status=sufficient. Insufficient context may yield nulls, never invented scoring evidence.

GET /health -> {status:"ok",service:"cuevia-ai",contract_version:"1"}
POST /profile JSON {cv_text:string,event_topics:string[]} -> {skills:[{name,evidence}],topic_estimates:TopicEvidence[],interests:string[],model_id:string}
POST /transcribe multipart {file,language:string} -> {text:string,model_id:string}; audio chunk boundaries/timestamps remain backend-owned
POST /catch-up JSON {segments:Segment[],locale:string} -> {cue:string,summary:string,source_segment_ids:string[],model_id:string}
POST /explain JSON {term:string,segments:Segment[],background:TopicEvidence[],depth:"simple"|"standard"|"advanced",locale:string,provided_sources:Source[]} -> Explanation plus model_id:string
POST /evaluate-question JSON {question_text:string,segments:Segment[],submitted_at:string,window_start_at:string,allowed_topics:string[],context_available:boolean,locale:string} -> AIQuestionEvaluation
POST /match JSON {opportunity:{id,title,topics:string[],required_skills:string[]},profile_evidence:{skills:[{name,evidence}],interests:string[]},questions:[{text,topics:string[]}]} -> {reasons:string[],missing_requirements:string[],supported_question_indices:int[],model_id:string}
Every private route except basic health verifies X-Internal-Token.
Question judge never receives the CV or identity. It sees question and server-selected preceding-three-minute context only.
Native JSON/tool support varies by model/provider: use prompt JSON plus validation when necessary.
```
