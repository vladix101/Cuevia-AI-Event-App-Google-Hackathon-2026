from __future__ import annotations

import io
import json
import wave

import httpx
import numpy as np
import pytest

from cuevia_ai.audio import TARGET_RATE, normalize_audio
from cuevia_ai.errors import AIServiceError
from cuevia_ai.pipelines import is_generic_clarification
from cuevia_ai.search import is_safe_public_url
from conftest import StubGemma, make_client, settings_with

ASR = dict(gemma_asr_mode="openai_compatible", gemma_asr_model="gemma4:e2b",
           gemma_asr_endpoint="http://asr.test/v1")


def _wav(seconds: float = 1.0, rate: int = 44_100, channels: int = 2) -> bytes:
    t = np.linspace(0, seconds, int(rate * seconds), endpoint=False)
    tone = (0.3 * np.sin(2 * np.pi * 440 * t) * 32767).astype("<i2")
    frames = np.repeat(tone[:, None], channels, axis=1).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


def test_normalize_to_16k_mono():
    out, duration = normalize_audio(_wav(1.0, 44_100, 2), max_seconds=30)
    with wave.open(io.BytesIO(out)) as w:
        assert (w.getnchannels(), w.getframerate(), w.getsampwidth()) == (1, TARGET_RATE, 2)
        assert abs(w.getnframes() - TARGET_RATE) <= 1
    assert abs(duration - 1.0) < 0.01


def test_audio_too_long():
    with pytest.raises(AIServiceError) as e:
        normalize_audio(_wav(3.0, 16_000, 1), max_seconds=2)
    assert e.value.code == "AUDIO_TOO_LONG"


def test_non_wav_without_ffmpeg(monkeypatch):
    monkeypatch.setattr("cuevia_ai.audio.shutil.which", lambda _: None)
    with pytest.raises(AIServiceError) as e:
        normalize_audio(b"\x1aE\xdf\xa3webm-bytes", max_seconds=30)
    assert e.value.code == "UNSUPPORTED_AUDIO_FORMAT"


def test_transcribe_disabled_is_explicit(headers):
    stub = StubGemma()
    r = make_client(stub).post("/internal/v1/transcribe", files={"file": ("a.wav", _wav(), "audio/wav")},
                               data={"language": "sr"}, headers=headers)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "AUDIO_UNAVAILABLE"
    assert stub.requests == []


def test_transcribe_refuses_model_without_audio_capability(headers):
    calls = []

    def asr(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": ["completion", "vision"]})
        raise AssertionError("must not attempt transcription")

    client = make_client(StubGemma(), settings_with(**ASR), audio_handler=asr)
    r = client.post("/internal/v1/transcribe", files={"file": ("a.wav", _wav(), "audio/wav")}, headers=headers)
    assert r.status_code == 503 and r.json()["error"]["code"] == "AUDIO_UNAVAILABLE"
    assert calls == ["/api/show"]


def test_transcribe_sends_normalized_wav(headers):
    sent = {}

    def asr(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": ["completion", "audio"]})
        body = json.loads(request.content)
        sent.update(body)
        return httpx.Response(200, json={"model": "gemma4:e2b", "choices": [
            {"message": {"content": "Dobro veče svima."}}], "usage": {}})

    client = make_client(StubGemma(), settings_with(**ASR), audio_handler=asr)
    r = client.post("/internal/v1/transcribe", files={"file": ("a.wav", _wav(), "audio/wav")},
                    data={"language": "sr"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "Dobro veče svima.", "model_id": "gemma4:e2b"}
    part = sent["messages"][0]["content"][1]
    assert part["type"] == "input_audio" and part["input_audio"]["format"] == "wav"
    assert sent["model"] == "gemma4:e2b"


def test_transcribe_no_speech_returns_empty_text(headers):
    def asr(request):
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": ["audio"]})
        return httpx.Response(200, json={"model": "gemma4:e2b", "choices": [{"message": {"content": "[no speech]"}}]})

    client = make_client(StubGemma(), settings_with(**ASR), audio_handler=asr)
    r = client.post("/internal/v1/transcribe", files={"file": ("a.wav", _wav(), "audio/wav")}, headers=headers)
    assert r.json()["text"] == ""


def test_non_gemma_asr_model_refused(headers):
    client = make_client(StubGemma(), settings_with(**dict(ASR, gemma_asr_model="whisper-large-v3")))
    r = client.post("/internal/v1/transcribe", files={"file": ("a.wav", _wav(), "audio/wav")}, headers=headers)
    assert r.status_code == 503 and r.json()["error"]["code"] == "AUDIO_UNAVAILABLE"


@pytest.mark.parametrize("url,ok", [
    ("https://docs.python.org/3/", True), ("http://example.com/a?b=c", True),
    ("http://localhost:8000", False), ("http://127.0.0.1/", False), ("http://10.1.2.3/", False),
    ("http://169.254.169.254/latest", False), ("http://[::1]/", False), ("ftp://example.com", False),
    ("javascript:alert(1)", False), ("https://user:pw@example.com", False), ("http://2130706433/", False),
    ("http://metadata.internal/", False), ("https://example.com:8443/", False), ("http://intranet/", False),
])
def test_url_safety(url, ok):
    assert is_safe_public_url(url) is ok


@pytest.mark.parametrize("q,generic", [
    ("Možete li da ponovite?", True), ("Mozete li ponovo?", True), ("Ponovite molim vas.", True),
    ("Nisam čuo poslednji deo.", True), ("Can you repeat that?", True), ("Sorry, what?", True),
    ("Možete li glasnije?", True), ("Izvinite, možete li da ponovite poslednju rečenicu?", True),
    ("Možete li da ponovite kako ef_search utiče na recall?", False),
    ("Sorry, how does HNSW handle deletes?", False), ("What is HNSW?", False),
    ("Kako HNSW podnosi brisanja?", False),
])
def test_generic_clarification_rule(q, generic):
    assert is_generic_clarification(q) is generic
