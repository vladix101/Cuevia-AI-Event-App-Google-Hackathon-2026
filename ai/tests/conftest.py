"""Test harness. The Gemma provider is replaced by an httpx.MockTransport STUB that lives only
in tests; production code never substitutes a mock or another model."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Callable, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from cuevia_ai.config import Settings
from cuevia_ai.gemma import GemmaAudioClient, GemmaClient
from cuevia_ai.main import Services, create_app
from cuevia_ai.search import BraveSearch

FIX = Path(__file__).parent / "fixtures"
TOKEN = "test-internal-token"
MODEL = "gemma-3-27b-it"


def fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


BASE_SETTINGS = Settings(
    ai_service_token=TOKEN,
    gemma_provider="openai_compatible",
    gemma_model=MODEL,
    gemma_api_base_url="http://gemma.test/v1",
    gemma_asr_mode="disabled",
)


class StubGemma:
    """Queue of reply strings returned as OpenAI-compatible chat completions."""

    def __init__(self, replies: Optional[list] = None, model: str = MODEL):
        self.replies = list(replies or [])
        self.model = model
        self.requests: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.requests.append(body)
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": self.model}]})
        if not self.replies:
            raise AssertionError("StubGemma ran out of scripted replies")
        reply = self.replies.pop(0)
        content = reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
        return httpx.Response(200, json={
            "model": self.model,
            "choices": [{"message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        })

    @property
    def prompts(self) -> list[str]:
        return [r["messages"][0]["content"] for r in self.requests if "messages" in r]


def make_client(stub: StubGemma, settings: Settings = BASE_SETTINGS,
                brave_handler: Optional[Callable] = None, audio_handler: Optional[Callable] = None,
                brave_key: str = "") -> TestClient:
    gemma = GemmaClient(settings, http=httpx.AsyncClient(transport=httpx.MockTransport(stub.handler)))
    audio = GemmaAudioClient(settings, http=httpx.AsyncClient(
        transport=httpx.MockTransport(audio_handler or stub.handler)))
    search = BraveSearch(brave_key, http=httpx.AsyncClient(
        transport=httpx.MockTransport(brave_handler or (lambda r: httpx.Response(500)))))
    services = Services(settings, gemma, audio, search)
    return TestClient(create_app(settings, services))


@pytest.fixture
def headers() -> dict:
    return {"X-Internal-Token": TOKEN}


@pytest.fixture
def segments() -> list[dict]:
    return fixture("transcript_segments.json")["segments"]


def judge_body(text: str, segments: list[dict], context: bool = True, **extra) -> dict:
    q = fixture("questions.json")
    body = {"question_text": text, "segments": segments, "submitted_at": q["submitted_at"],
            "window_start_at": q["window_start_at"], "allowed_topics": q["allowed_topics"],
            "context_available": context, "locale": "sr"}
    body.update(extra)
    return body


def settings_with(**kw) -> Settings:
    return replace(BASE_SETTINGS, **kw)
