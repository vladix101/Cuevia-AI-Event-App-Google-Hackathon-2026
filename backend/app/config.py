from functools import lru_cache

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Export backend/.env into the process env: Google client libraries read the *_EMULATOR_HOST
# variables from os.environ directly. Real environment variables take precedence.
load_dotenv(override=False)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # Firebase / GCP
    firebase_project_id: str = "demo-cuevia"
    # Path to a service-account JSON; empty uses Application Default Credentials (or emulators).
    google_application_credentials: str = ""

    # Private AI service
    ai_service_url: str = "http://localhost:8001/internal/v1"
    ai_service_token: str = ""
    ai_timeout_seconds: float = 60.0

    # Public API
    cors_origins: str = "http://localhost:5173"
    max_cv_bytes: int = 5 * 1024 * 1024
    max_chunk_bytes: int = 2 * 1024 * 1024
    sample_rate_hz: int = 16000
    chunk_seconds: int = 5
    # Allowed clock skew between client recording offsets and server time.
    clock_skew_ms: int = 15000
    rate_limit_per_minute: int = 120

    # Deterministic policy (prototype gate)
    policy_version: str = "policy-v1"
    question_limit: int = 3
    context_window_seconds: int = 180
    gate_min_relevance: float = 6.0
    topic_bonus_cap: float = 10.0
    top_k: int = 5

    # Background worker
    worker_enabled: bool = True
    # Spark plan: 50k reads/day. New tasks wake the worker immediately; polling only covers retries/recovery.
    worker_poll_seconds: float = 15.0
    task_lease_seconds: int = 120
    task_max_attempts: int = 5
    # How long a question judgment waits for transcript context to finish processing.
    judge_context_wait_seconds: int = 60

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
