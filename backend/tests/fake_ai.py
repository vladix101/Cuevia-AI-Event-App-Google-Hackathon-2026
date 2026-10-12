"""DETERMINISTIC TEST FIXTURE — not a model. Used only by backend/tests via httpx.MockTransport.

Implements contracts/ai-v1.md shapes with fixed rules so backend policy can be tested without Gemma.
Runtime code never imports this module.
"""
import json

import httpx

FIXTURE_MODEL = "test-fixture-not-a-model"
TOKEN = "test-internal-token"


class FakeAI:
    def __init__(self):
        self.calls: list[tuple[str, dict | None]] = []
        self.down = False
        self.fail_paths: set[str] = set()
        # question text -> evaluation overrides
        self.evaluations: dict[str, dict] = {}
        self.cv_topics: dict[str, float | None] = {"machine learning": 70.0, "cloud": None}

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def paths(self) -> list[str]:
        return [p for p, _ in self.calls]

    def bodies(self, path: str) -> list[dict]:
        return [b for p, b in self.calls if p == path]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.split("/internal/v1")[-1]
        if self.down:
            raise httpx.ConnectError("fixture: AI down")
        if request.headers.get("X-Internal-Token") != TOKEN and path != "/health":
            return httpx.Response(401, json={"error": "bad token"})
        body = json.loads(request.content) if request.headers.get("content-type", "").startswith("application/json") else None
        self.calls.append((path, body))
        if path in self.fail_paths:
            return httpx.Response(500, json={"error": "fixture failure"})
        return httpx.Response(200, json=getattr(self, "_" + path.strip("/").replace("-", "_"))(request, body))

    def _health(self, request, body):
        return {"status": "ok", "service": "cuevia-ai", "contract_version": "1"}

    def _profile(self, request, body):
        return {"skills": [{"name": "Python", "evidence": "CV mentions Python"}],
                "topic_estimates": [{"topic": t, "baseline": b, "uncertainty": "medium", "evidence": ["cv"]}
                                    for t, b in self.cv_topics.items()],
                "interests": list(self.cv_topics), "model_id": FIXTURE_MODEL}

    def _transcribe(self, request, body):
        return {"text": "Danas pričamo o machine learning modelima i transformerima.", "model_id": FIXTURE_MODEL}

    def _catch_up(self, request, body):
        ids = [s["id"] for s in body["segments"]]
        return {"cue": "Transformeri", "summary": "Govornik objašnjava transformere.", "source_segment_ids": ids + ["bogus"],
                "model_id": FIXTURE_MODEL}

    def _explain(self, request, body):
        return {"explanation": f"{body['term']} je pojam.", "example": "Primer.",
                "sources": [{"id": "s1", "title": "Wiki", "url": "https://example.org"}],
                "retrieval_mode": "general", "model_id": FIXTURE_MODEL}

    def _evaluate_question(self, request, body):
        base = {"relevance": 8, "expertise": 7, "depth": 6,
                "topics": [{"topic": "Machine Learning", "evidence": "q", "confidence": "high"},
                           {"topic": "not-an-event-topic", "evidence": "q", "confidence": "high"}],
                "rationale": {"relevance": "r", "expertise": "e", "depth": "d"},
                "source_segment_ids": [s["id"] for s in body["segments"]],
                "context_status": "sufficient", "is_generic_clarification": False,
                "model_id": FIXTURE_MODEL, "rubric_version": "fixture-v1"}
        return {**base, **self.evaluations.get(body["question_text"], {})}

    def _match(self, request, body):
        return {"reasons": [f"Fit for {body['opportunity']['title']}"], "missing_requirements": [],
                "supported_question_indices": list(range(len(body["questions"]))), "model_id": FIXTURE_MODEL}
