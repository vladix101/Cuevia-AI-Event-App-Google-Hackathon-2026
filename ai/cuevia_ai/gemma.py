"""Single Gemma adapter for the configured provider/model.

Providers
---------
* ``openai_compatible`` - any documented OpenAI-compatible chat-completions server that serves
  a Gemma model (verified: Ollama 0.34 ``/v1`` with ``gemma4:e2b``; also vLLM/LM Studio).
* ``google`` - Google Generative Language REST API (``generateContent``) serving hosted Gemma
  models such as ``gemma-3-27b-it``. Gemma models there do not accept system instructions or
  JSON mode, so the prompt is a single user turn and JSON is validated locally.

Policy
------
* Only Gemma model ids pass the allowlist; there is no fallback model. If the configured
  model is missing or the provider answers with a different model id, the call fails loudly.
* JSON outputs are parsed + validated by the caller's validator; one schema-repair retry,
  then ``MODEL_OUTPUT_INVALID``.
* Logs contain call metadata (route, provider, model, latency, token usage) - never prompts,
  CV text, model outputs or keys. Reasoning/thinking content is discarded, never retained.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional, TypeVar

import httpx

from .config import Settings, is_allowed_gemma_model
from .errors import AIServiceError
from .net import async_client

log = logging.getLogger("cuevia_ai.gemma")

T = TypeVar("T")

GOOGLE_API_ROOT = "https://generativelanguage.googleapis.com/v1beta"


class OutputValidationError(ValueError):
    """Raised by route validators when model JSON is structurally or semantically invalid."""


@dataclass
class Generation:
    text: str
    model_id: str
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None


def _normalize_model(model_id: str) -> str:
    m = (model_id or "").strip().lower()
    if m.startswith("models/"):
        m = m[len("models/"):]
    return m


_THINK_BLOCKS = re.compile(r"<think>.*?</think>|<\|channel\>thought.*?<channel\|>", re.DOTALL | re.IGNORECASE)


def strip_reasoning(text: str) -> str:
    return _THINK_BLOCKS.sub("", text or "").strip()


def extract_json_object(text: str) -> dict:
    """Parse the first JSON object in a model reply (tolerates ```json fences / stray prose)."""
    cleaned = strip_reasoning(text)
    fence = re.search(r"```(?:json)?\s*(.*?)```", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise OutputValidationError("Reply did not contain a JSON object.")
    try:
        obj = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise OutputValidationError(f"Reply was not valid JSON: {exc.msg}.") from exc
    if not isinstance(obj, dict):
        raise OutputValidationError("Top-level JSON value must be an object.")
    return obj


class GemmaClient:
    def __init__(self, settings: Settings, http: Optional[httpx.AsyncClient] = None):
        self.s = settings
        self._http = http
        self._sem = asyncio.Semaphore(max(1, settings.gemma_max_concurrency))
        self._model_verified: Optional[bool] = None

    # ---- configuration -----------------------------------------------------------------

    @property
    def model_id(self) -> str:
        return self.s.gemma_model

    def ensure_configured(self) -> None:
        s = self.s
        if not s.gemma_model:
            raise AIServiceError(503, "MODEL_NOT_CONFIGURED", "GEMMA_MODEL is not configured.")
        if not is_allowed_gemma_model(s.gemma_model):
            raise AIServiceError(503, "MODEL_NOT_ALLOWED", "Configured model is not a Gemma-family model.")
        if s.gemma_provider == "openai_compatible" and not s.gemma_api_base_url:
            raise AIServiceError(503, "MODEL_NOT_CONFIGURED", "GEMMA_API_BASE_URL is not configured.")
        if s.gemma_provider == "google" and not s.gemma_api_key:
            raise AIServiceError(503, "MODEL_NOT_CONFIGURED", "GEMMA_API_KEY is not configured.")
        if s.gemma_provider not in ("openai_compatible", "google"):
            raise AIServiceError(503, "MODEL_NOT_CONFIGURED", "Unsupported GEMMA_PROVIDER.")

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = async_client(self.s.gemma_timeout_seconds)
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    # ---- model availability ------------------------------------------------------------

    async def verify_model(self) -> dict:
        """Check that the configured model is actually served by the provider."""
        self.ensure_configured()
        s = self.s
        try:
            if s.gemma_provider == "openai_compatible":
                r = await self._client().get(f"{s.gemma_api_base_url}/models", headers=self._oa_headers(), timeout=10)
                r.raise_for_status()
                ids = {_normalize_model(m.get("id", "")) for m in r.json().get("data", [])}
                ok = _normalize_model(s.gemma_model) in ids
            else:
                name = s.gemma_model if s.gemma_model.startswith("models/") else f"models/{s.gemma_model}"
                r = await self._client().get(
                    f"{GOOGLE_API_ROOT}/{name}", headers={"x-goog-api-key": s.gemma_api_key}, timeout=10
                )
                ok = r.status_code == 200
        except (httpx.HTTPError, ValueError) as exc:
            self._model_verified = None
            return {"model": s.gemma_model, "provider": s.gemma_provider, "available": None,
                    "detail": f"could not verify: {type(exc).__name__}"}
        self._model_verified = ok
        return {"model": s.gemma_model, "provider": s.gemma_provider, "available": ok}

    # ---- generation --------------------------------------------------------------------

    def _oa_headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.s.gemma_api_key:
            h["Authorization"] = f"Bearer {self.s.gemma_api_key}"
        return h

    async def generate(self, prompt: str, *, route: str, max_tokens: Optional[int] = None,
                       json_output: bool = True, temperature: float = 0.0) -> Generation:
        self.ensure_configured()
        if self._model_verified is False:
            raise AIServiceError(503, "MODEL_UNAVAILABLE", "Configured Gemma model is not served by the provider.")
        max_tokens = max_tokens or self.s.gemma_max_output_tokens
        started = time.perf_counter()
        status = "ok"
        gen: Optional[Generation] = None
        try:
            async with self._sem:
                for attempt in (1, 2):
                    try:
                        if self.s.gemma_provider == "openai_compatible":
                            gen = await self._generate_openai(prompt, max_tokens, json_output, temperature)
                        else:
                            gen = await self._generate_google(prompt, max_tokens, json_output, temperature)
                        break
                    except httpx.HTTPStatusError as exc:
                        # One retry for transient provider errors (observed: intermittent 500s on hosted Gemma).
                        if attempt == 2 or exc.response.status_code not in (429, 500, 502, 503):
                            raise
                        log.info("gemma_transient_retry route=%s status=%s", route, exc.response.status_code)
                        await asyncio.sleep(1.5)
            return gen
        except AIServiceError as exc:
            status = exc.code
            raise
        except httpx.TimeoutException as exc:
            status = "UPSTREAM_TIMEOUT"
            raise AIServiceError(504, "UPSTREAM_TIMEOUT", "Gemma provider timed out.") from exc
        except httpx.HTTPStatusError as exc:
            status = f"HTTP_{exc.response.status_code}"
            raise AIServiceError(
                502, "UPSTREAM_ERROR", f"Gemma provider returned HTTP {exc.response.status_code}."
            ) from exc
        except httpx.HTTPError as exc:
            status = "UPSTREAM_UNREACHABLE"
            raise AIServiceError(503, "MODEL_UNAVAILABLE", "Gemma provider is unreachable.") from exc
        finally:
            log.info(
                "gemma_call route=%s provider=%s model=%s status=%s latency_ms=%d prompt_tokens=%s completion_tokens=%s",
                route, self.s.gemma_provider, self.s.gemma_model, status,
                int((time.perf_counter() - started) * 1000),
                gen.prompt_tokens if gen else None, gen.completion_tokens if gen else None,
            )

    async def _generate_openai(self, prompt: str, max_tokens: int, json_output: bool, temperature: float) -> Generation:
        body: dict[str, Any] = {
            "model": self.s.gemma_model,
            # Single user turn: Gemma chat templates do not all support a system role.
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if json_output and self.s.gemma_json_mode:
            body["response_format"] = {"type": "json_object"}
        if self.s.gemma_disable_thinking:
            body["reasoning_effort"] = "none"
        r = await self._client().post(
            f"{self.s.gemma_api_base_url}/chat/completions", headers=self._oa_headers(), json=body
        )
        r.raise_for_status()
        data = r.json()
        returned = data.get("model") or ""
        self._check_returned_model(returned, self.s.gemma_model)
        choice = (data.get("choices") or [{}])[0]
        text = strip_reasoning(((choice.get("message") or {}).get("content")) or "")
        usage = data.get("usage") or {}
        return Generation(text, self.s.gemma_model, usage.get("prompt_tokens"), usage.get("completion_tokens"))

    async def _generate_google(self, prompt: str, max_tokens: int, json_output: bool, temperature: float) -> Generation:
        name = self.s.gemma_model if self.s.gemma_model.startswith("models/") else f"models/{self.s.gemma_model}"
        config: dict[str, Any] = {"temperature": temperature, "maxOutputTokens": max_tokens}
        if json_output and self.s.gemma_json_mode:
            config["responseMimeType"] = "application/json"
        if self.s.gemma_disable_thinking:
            # Verified for gemma-4-26b-a4b-it / gemma-4-31b-it: "minimal" is accepted and yields no
            # thought tokens; thinkingBudget and other levels are rejected with HTTP 400.
            config["thinkingConfig"] = {"thinkingLevel": "minimal"}
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": config}
        r = await self._client().post(
            f"{GOOGLE_API_ROOT}/{name}:generateContent",
            headers={"x-goog-api-key": self.s.gemma_api_key, "Content-Type": "application/json"},
            json=body,
        )
        r.raise_for_status()
        data = r.json()
        self._check_returned_model(data.get("modelVersion") or "", self.s.gemma_model)
        parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts")) or []
        # Skip parts flagged as model thoughts; they are never retained.
        text = strip_reasoning("".join(p.get("text", "") for p in parts if not p.get("thought")))
        usage = data.get("usageMetadata") or {}
        return Generation(text, self.s.gemma_model, usage.get("promptTokenCount"), usage.get("candidatesTokenCount"))

    @staticmethod
    def _check_returned_model(returned: str, configured: str) -> None:
        if not returned:
            return
        r, c = _normalize_model(returned), _normalize_model(configured)
        # Providers may append a revision suffix (e.g. "gemma-3-27b-it-001"); anything else is a swap.
        if r != c and not r.startswith(c) and not c.startswith(r):
            raise AIServiceError(502, "MODEL_MISMATCH", "Provider answered with a different model than configured.")
        if not is_allowed_gemma_model(returned):
            raise AIServiceError(502, "MODEL_MISMATCH", "Provider answered with a non-Gemma model.")

    async def generate_json(self, prompt: str, validate: Callable[[dict], T], *, route: str,
                            max_tokens: Optional[int] = None) -> tuple[T, str]:
        """Generate, parse and validate JSON. One repair retry, then an honest error."""
        gen = await self.generate(prompt, route=route, max_tokens=max_tokens)
        try:
            return validate(extract_json_object(gen.text)), gen.model_id
        except (OutputValidationError, ValueError) as first_err:
            problem = str(first_err)[:800]
        log.info("gemma_schema_repair route=%s", route)
        repair = (
            f"{prompt}\n\n---\nYour previous reply was rejected by the validator: {problem}\n"
            "Reply again with ONLY one corrected JSON object that follows every rule above. "
            "Do not add commentary."
        )
        gen = await self.generate(repair, route=route, max_tokens=max_tokens)
        try:
            return validate(extract_json_object(gen.text)), gen.model_id
        except (OutputValidationError, ValueError) as second_err:
            log.warning("gemma_output_invalid route=%s reason=%s", route, str(second_err)[:200])
            raise AIServiceError(
                502, "MODEL_OUTPUT_INVALID", "Gemma output failed schema validation after one repair attempt."
            ) from second_err


class GemmaAudioClient:
    """Audio transcription through a separately configured audio-capable Gemma endpoint.

    Verified transport: OpenAI-compatible ``input_audio`` content parts (Ollama >= 0.30.9 with
    ``gemma4:e2b``/``gemma4:e4b``). When the endpoint is an Ollama server, the model's declared
    capabilities are checked via ``/api/show`` and a model without ``audio`` is refused.
    """

    NO_SPEECH = "[no speech]"

    def __init__(self, settings: Settings, http: Optional[httpx.AsyncClient] = None):
        self.s = settings
        self._http = http
        self._capability: Optional[dict] = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = async_client(self.s.gemma_timeout_seconds)
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    def ensure_configured(self) -> None:
        s = self.s
        if not s.asr_enabled:
            raise AIServiceError(
                503, "AUDIO_UNAVAILABLE",
                "Audio transcription is not configured (GEMMA_ASR_MODE=disabled). No fallback ASR is used.",
            )
        if not s.gemma_asr_model or not is_allowed_gemma_model(s.gemma_asr_model):
            raise AIServiceError(503, "AUDIO_UNAVAILABLE", "GEMMA_ASR_MODEL is not an allowed Gemma model.")
        if not s.gemma_asr_endpoint:
            raise AIServiceError(503, "AUDIO_UNAVAILABLE", "GEMMA_ASR_ENDPOINT is not configured.")

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.s.gemma_asr_api_key:
            h["Authorization"] = f"Bearer {self.s.gemma_asr_api_key}"
        return h

    async def capability(self) -> dict:
        """Ask the endpoint what the model supports. Cached after a definitive answer."""
        self.ensure_configured()
        if self._capability is not None:
            return self._capability
        root = re.sub(r"/v1/?$", "", self.s.gemma_asr_endpoint)
        try:
            r = await self._client().post(f"{root}/api/show", json={"model": self.s.gemma_asr_model}, timeout=10)
        except httpx.HTTPError as exc:
            return {"audio": None, "detail": f"endpoint unreachable: {type(exc).__name__}"}
        if r.status_code == 200 and isinstance(r.json().get("capabilities"), list):
            caps = r.json()["capabilities"]
            self._capability = {"audio": "audio" in caps, "detail": f"declared capabilities: {caps}"}
        elif r.status_code == 404 and "not found" in r.text.lower() and "model" in r.text.lower():
            self._capability = {"audio": False, "detail": "model not found on endpoint"}
        else:
            # Not an Ollama server: capability is not declared; the actual call decides.
            self._capability = {"audio": None, "detail": "capability not declared by endpoint"}
        return self._capability

    async def transcribe(self, wav_bytes: bytes, language: str) -> tuple[str, str]:
        cap = await self.capability()
        if cap.get("audio") is False:
            raise AIServiceError(503, "AUDIO_UNAVAILABLE", f"Configured ASR model cannot take audio ({cap['detail']}).")
        prompt = (
            "Transcribe the speech in this audio clip verbatim, in the language it is spoken "
            f"(expected language code: {language}). Output only the transcript text, with no "
            f"timestamps, labels or commentary. If there is no intelligible speech, output exactly {self.NO_SPEECH}"
        )
        body: dict[str, Any] = {
            "model": self.s.gemma_asr_model,
            "temperature": 0,
            "stream": False,
            "max_tokens": 512,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "input_audio",
                     "input_audio": {"data": base64.b64encode(wav_bytes).decode("ascii"), "format": "wav"}},
                ],
            }],
        }
        if self.s.gemma_disable_thinking:
            body["reasoning_effort"] = "none"
        started = time.perf_counter()
        status = "ok"
        usage: dict = {}
        try:
            r = await self._client().post(
                f"{self.s.gemma_asr_endpoint}/chat/completions", headers=self._headers(), json=body
            )
            if r.status_code >= 400:
                status = f"HTTP_{r.status_code}"
                raise AIServiceError(502, "UPSTREAM_ERROR", f"Gemma audio endpoint returned HTTP {r.status_code}.")
            data = r.json()
            usage = data.get("usage") or {}
            GemmaClient._check_returned_model(data.get("model") or "", self.s.gemma_asr_model)
            text = strip_reasoning(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        except httpx.TimeoutException as exc:
            status = "UPSTREAM_TIMEOUT"
            raise AIServiceError(504, "UPSTREAM_TIMEOUT", "Gemma audio endpoint timed out.") from exc
        except httpx.HTTPError as exc:
            status = "UPSTREAM_UNREACHABLE"
            raise AIServiceError(503, "AUDIO_UNAVAILABLE", "Gemma audio endpoint is unreachable.") from exc
        finally:
            log.info(
                "gemma_call route=transcribe provider=asr model=%s status=%s latency_ms=%d prompt_tokens=%s completion_tokens=%s",
                self.s.gemma_asr_model, status, int((time.perf_counter() - started) * 1000),
                usage.get("prompt_tokens"), usage.get("completion_tokens"),
            )
        if text.strip().lower() == self.NO_SPEECH:
            text = ""
        return text.strip(), self.s.gemma_asr_model
