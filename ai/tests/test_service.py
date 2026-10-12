from __future__ import annotations

import pytest

from cuevia_ai.config import is_allowed_gemma_model
from conftest import BASE_SETTINGS, MODEL, TOKEN, StubGemma, fixture, make_client, settings_with


def test_health_contract_and_no_secrets():
    client = make_client(StubGemma())
    r = client.get("/internal/v1/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "cuevia-ai", "contract_version": "1"}
    assert TOKEN not in r.text


@pytest.mark.parametrize("hdrs", [{}, {"X-Internal-Token": "wrong"}])
def test_private_routes_require_token(hdrs):
    client = make_client(StubGemma())
    r = client.post("/internal/v1/match", json={}, headers=hdrs)
    assert r.status_code == 401
    err = r.json()["error"]
    assert err["code"] == "UNAUTHORIZED" and err["request_id"]


def test_missing_service_token_fails_closed():
    client = make_client(StubGemma(), settings_with(ai_service_token=""))
    r = client.post("/internal/v1/match", json={}, headers={"X-Internal-Token": ""})
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "SERVICE_NOT_CONFIGURED"


@pytest.mark.parametrize("model,ok", [
    ("gemma4:e2b", True), ("gemma-3-27b-it", True), ("models/gemma-3-12b-it", True),
    ("google/gemma-3n-E4B-it", True), ("gemini-2.5-flash", False), ("gpt-4o", False),
    ("whisper-large-v3", False), ("llama3:8b", False), ("", False), ("gemma-gemini-mix", False),
])
def test_model_allowlist(model, ok):
    assert is_allowed_gemma_model(model) is ok


def test_non_gemma_model_is_refused(headers):
    stub = StubGemma()
    client = make_client(stub, settings_with(gemma_model="gemini-2.5-flash"))
    r = client.post("/internal/v1/catch-up", json={"segments": fixture("transcript_segments.json")["segments"]},
                    headers=headers)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "MODEL_NOT_ALLOWED"
    assert stub.requests == []


def test_missing_model_config_is_explicit(headers, segments):
    client = make_client(StubGemma(), settings_with(gemma_model=""))
    r = client.post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "MODEL_NOT_CONFIGURED"


def test_provider_model_swap_is_rejected(headers, segments):
    stub = StubGemma([{"cue": "a b c", "summary": "x.", "source_segment_ids": ["seg-001"]}], model="llama3:8b")
    client = make_client(stub)
    r = client.post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "MODEL_MISMATCH"


def test_malformed_json_is_repaired_once(headers, segments):
    good = {"cue": "HNSW i ef_search parametar", "summary": "Govornik objašnjava HNSW.",
            "source_segment_ids": ["seg-004", "seg-005"]}
    stub = StubGemma(["not json at all", good])
    r = make_client(stub).post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 200, r.text
    assert len(stub.prompts) == 2
    assert "rejected by the validator" in stub.prompts[1]


def test_second_invalid_output_is_honest_error(headers, segments):
    stub = StubGemma(["{broken", "```json\n{\"cue\": 5}\n```"])
    r = make_client(stub).post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "MODEL_OUTPUT_INVALID"


def test_upstream_http_error_maps_to_error_shape(headers, segments):
    import httpx

    from conftest import make_client as mk

    class Failing(StubGemma):
        def handler(self, request):
            return httpx.Response(500, json={"error": "boom"})

    r = mk(Failing()).post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 502
    assert set(r.json()["error"]) == {"code", "message", "request_id"}


def test_validation_error_does_not_echo_cv(headers):
    r = make_client(StubGemma()).post("/internal/v1/profile", json={"cv_text": "SECRET-CV-TEXT", "event_topics": "x"},
                                      headers=headers)
    assert r.status_code == 422
    assert "SECRET-CV-TEXT" not in r.text
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_reasoning_blocks_are_discarded(headers, segments):
    reply = '<think>internal reasoning</think>{"cue": "HNSW i ef_search parametar", "summary": "Kratko.", ' \
            '"source_segment_ids": ["seg-005"]}'
    r = make_client(StubGemma([reply])).post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 200
    assert "internal reasoning" not in r.text


def test_settings_validate_reports_problems_without_secrets():
    problems = settings_with(gemma_model="gpt-4o", gemma_api_key="sk-secret").validate()
    assert any("Gemma-family" in p for p in problems)
    assert not any("sk-secret" in p for p in problems)
    assert BASE_SETTINGS.validate() == []
    assert MODEL
