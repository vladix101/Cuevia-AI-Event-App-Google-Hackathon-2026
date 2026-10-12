"""Google Generative Language provider, with the HTTP endpoint STUBBED (tests only)."""

from __future__ import annotations

import json

import httpx
from fastapi.testclient import TestClient

from cuevia_ai.gemma import GemmaAudioClient, GemmaClient
from cuevia_ai.main import Services, create_app
from cuevia_ai.search import BraveSearch
from conftest import settings_with

GOOGLE = settings_with(gemma_provider="google", gemma_api_key="test-key", gemma_model="gemma-4-26b-a4b-it",
                       gemma_api_base_url="")
REPLY = {"cue": "HNSW i ef_search parametar", "summary": "Govornik objašnjava HNSW.", "source_segment_ids": ["seg-005"]}


def _client(handler) -> TestClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    services = Services(GOOGLE, GemmaClient(GOOGLE, http=http), GemmaAudioClient(GOOGLE, http=http),
                        BraveSearch("", http=http))
    return TestClient(create_app(GOOGLE, services))


def _google_response(parts, model="gemma-4-26b-a4b-it"):
    return httpx.Response(200, json={
        "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 7},
        "modelVersion": model,
    })


def test_google_request_shape_and_thoughts_dropped(headers, segments):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _google_response([{"text": "secret reasoning", "thought": True}, {"text": json.dumps(REPLY)}])

    r = _client(handler).post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 200, r.text
    assert "secret reasoning" not in r.text
    req = seen[0]
    assert req.url.path == "/v1beta/models/gemma-4-26b-a4b-it:generateContent"
    assert req.headers["x-goog-api-key"] == "test-key" and "key=" not in str(req.url)
    body = json.loads(req.content)
    assert "systemInstruction" not in body and len(body["contents"]) == 1
    cfg = body["generationConfig"]
    assert cfg["thinkingConfig"] == {"thinkingLevel": "minimal"}
    assert cfg["responseMimeType"] == "application/json"


def test_google_transient_500_retried_once(headers, segments):
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(500, json={"error": {"code": 500, "message": "Internal error encountered."}})
        return _google_response([{"text": json.dumps(REPLY)}])

    r = _client(handler).post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 200 and len(calls) == 2


def test_google_persistent_error_is_reported(headers, segments):
    r = _client(lambda req: httpx.Response(500, json={})).post(
        "/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 502 and r.json()["error"]["code"] == "UPSTREAM_ERROR"


def test_google_400_not_retried(headers, segments):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(400, json={"error": {"message": "bad"}})

    r = _client(handler).post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 502 and len(calls) == 1


def test_google_model_swap_rejected(headers, segments):
    r = _client(lambda req: _google_response([{"text": json.dumps(REPLY)}], model="gemini-2.5-flash")).post(
        "/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 502 and r.json()["error"]["code"] == "MODEL_MISMATCH"


def test_google_missing_key_is_explicit(headers, segments):
    s = settings_with(gemma_provider="google", gemma_api_key="", gemma_model="gemma-4-26b-a4b-it")
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    client = TestClient(create_app(s, Services(s, GemmaClient(s, http=http), GemmaAudioClient(s, http=http),
                                                 BraveSearch("", http=http))))
    r = client.post("/internal/v1/catch-up", json={"segments": segments}, headers=headers)
    assert r.status_code == 503 and r.json()["error"]["code"] == "MODEL_NOT_CONFIGURED"
