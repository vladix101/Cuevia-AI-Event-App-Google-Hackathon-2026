"""Server-only configuration loaded from the environment (and ai/.env when present).

Secrets never leave this process: they are not logged, not returned by any route
and not included in error messages.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

AI_DIR = Path(__file__).resolve().parent.parent

GEMMA_PROVIDERS = ("openai_compatible", "google")
ASR_MODES = ("disabled", "openai_compatible")

# Only Gemma family model identifiers are accepted. Examples that pass:
#   gemma4:e2b, gemma-3-27b-it, models/gemma-3-12b-it, google/gemma-3n-E4B-it
_GEMMA_ID = re.compile(r"^(?:models/)?(?:[\w.-]+/)?gemma[\w.:-]*$", re.IGNORECASE)
_FORBIDDEN_FAMILY = re.compile(r"gemini|gpt|claude|whisper|llama|qwen|mistral|phi", re.IGNORECASE)


class ConfigError(RuntimeError):
    """Raised when configuration is missing or would violate the Gemma-only policy."""


def is_allowed_gemma_model(model_id: str) -> bool:
    model_id = (model_id or "").strip()
    return bool(model_id) and bool(_GEMMA_ID.match(model_id)) and not _FORBIDDEN_FAMILY.search(model_id)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    return int(raw) if raw else default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    ai_service_token: str = ""
    gemma_provider: str = "google"
    gemma_api_key: str = ""
    gemma_model: str = ""
    gemma_api_base_url: str = ""
    gemma_timeout_seconds: float = 120.0
    gemma_max_output_tokens: int = 1024
    gemma_max_concurrency: int = 2
    gemma_json_mode: bool = True
    gemma_disable_thinking: bool = True
    gemma_asr_mode: str = "disabled"
    gemma_asr_model: str = ""
    gemma_asr_endpoint: str = ""
    gemma_asr_api_key: str = ""
    gemma_asr_max_seconds: int = 30
    gemma_asr_max_bytes: int = 10 * 1024 * 1024
    hf_token: str = ""
    brave_search_api_key: str = ""
    brave_timeout_seconds: float = 8.0
    log_level: str = "INFO"
    extra: dict = field(default_factory=dict)

    @property
    def text_configured(self) -> bool:
        return bool(self.gemma_model and self.gemma_provider)

    @property
    def asr_enabled(self) -> bool:
        return self.gemma_asr_mode != "disabled"

    def validate(self) -> list[str]:
        """Return a list of human-readable configuration problems (no secret values)."""
        problems: list[str] = []
        if not self.ai_service_token:
            problems.append("AI_SERVICE_TOKEN is not set; private routes will refuse every request.")
        if self.gemma_provider not in GEMMA_PROVIDERS:
            problems.append(f"GEMMA_PROVIDER must be one of {GEMMA_PROVIDERS}.")
        if not self.gemma_model:
            problems.append("GEMMA_MODEL is not set; text inference routes are unavailable.")
        elif not is_allowed_gemma_model(self.gemma_model):
            problems.append("GEMMA_MODEL is not a Gemma-family model id; refusing to use it.")
        if self.gemma_provider == "openai_compatible" and not self.gemma_api_base_url:
            problems.append("GEMMA_API_BASE_URL is required for GEMMA_PROVIDER=openai_compatible.")
        if self.gemma_provider == "google" and not self.gemma_api_key:
            problems.append("GEMMA_API_KEY is required for GEMMA_PROVIDER=google.")
        if self.gemma_asr_mode not in ASR_MODES:
            problems.append(f"GEMMA_ASR_MODE must be one of {ASR_MODES}.")
        if self.asr_enabled:
            if not self.gemma_asr_model or not is_allowed_gemma_model(self.gemma_asr_model):
                problems.append("GEMMA_ASR_MODEL must be an audio-capable Gemma model id.")
            if not self.gemma_asr_endpoint:
                problems.append("GEMMA_ASR_ENDPOINT is required when GEMMA_ASR_MODE is enabled.")
        return problems


def load_settings(env_file: Path | None = None, *, use_env_file: bool = True) -> Settings:
    if use_env_file:
        load_dotenv(env_file or AI_DIR / ".env", override=False)
    return Settings(
        ai_service_token=_env("AI_SERVICE_TOKEN"),
        gemma_provider=_env("GEMMA_PROVIDER", "google").lower(),
        gemma_api_key=_env("GEMMA_API_KEY"),
        gemma_model=_env("GEMMA_MODEL"),
        gemma_api_base_url=_env("GEMMA_API_BASE_URL").rstrip("/"),
        gemma_timeout_seconds=float(_env("GEMMA_TIMEOUT_SECONDS") or 120),
        gemma_max_output_tokens=_env_int("GEMMA_MAX_OUTPUT_TOKENS", 1024),
        gemma_max_concurrency=_env_int("GEMMA_MAX_CONCURRENCY", 2),
        gemma_json_mode=_env_bool("GEMMA_JSON_MODE", True),
        gemma_disable_thinking=_env_bool("GEMMA_DISABLE_THINKING", True),
        gemma_asr_mode=_env("GEMMA_ASR_MODE", "disabled").lower(),
        gemma_asr_model=_env("GEMMA_ASR_MODEL"),
        gemma_asr_endpoint=_env("GEMMA_ASR_ENDPOINT").rstrip("/"),
        gemma_asr_api_key=_env("GEMMA_ASR_API_KEY"),
        gemma_asr_max_seconds=_env_int("GEMMA_ASR_MAX_SECONDS", 30),
        gemma_asr_max_bytes=_env_int("GEMMA_ASR_MAX_BYTES", 10 * 1024 * 1024),
        hf_token=_env("HF_TOKEN"),
        brave_search_api_key=_env("BRAVE_SEARCH_API_KEY"),
        brave_timeout_seconds=float(_env("BRAVE_TIMEOUT_SECONDS") or 8),
        log_level=_env("LOG_LEVEL", "INFO").upper(),
    )
