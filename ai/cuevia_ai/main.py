"""FastAPI app for the private Cuevia AI service. Base path: /internal/v1, port 8001."""

from __future__ import annotations

import hmac
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import APIRouter, Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import CONTRACT_VERSION, SERVICE_NAME
from .audio import normalize_audio
from .config import Settings, load_settings
from .errors import (
    AIServiceError,
    ai_error_handler,
    http_error_handler,
    unhandled_error_handler,
    validation_error_handler,
)
from .gemma import GemmaAudioClient, GemmaClient
from .pipelines import LRUCache, build_profile, catch_up, evaluate_question, explain, match
from .schemas import (
    AIQuestionEvaluation,
    CatchUpRequest,
    CatchUpResponse,
    EvaluateQuestionRequest,
    ExplainRequest,
    ExplainResponse,
    HealthResponse,
    MatchRequest,
    MatchResponse,
    ProfileRequest,
    ProfileResponse,
    TranscribeResponse,
)
from .search import BraveSearch

log = logging.getLogger("cuevia_ai")


class Services:
    def __init__(self, settings: Settings, gemma: GemmaClient, audio: GemmaAudioClient, search: BraveSearch):
        self.settings = settings
        self.gemma = gemma
        self.audio = audio
        self.search = search
        self.catch_up_cache = LRUCache(256)

    async def aclose(self) -> None:
        await self.gemma.aclose()
        await self.audio.aclose()
        await self.search.aclose()


def create_app(settings: Optional[Settings] = None, services: Optional[Services] = None) -> FastAPI:
    settings = settings or load_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    services = services or Services(
        settings, GemmaClient(settings), GemmaAudioClient(settings),
        BraveSearch(settings.brave_search_api_key, settings.brave_timeout_seconds),
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        for problem in settings.validate():
            log.warning("config: %s", problem)
        log.info("cuevia-ai starting provider=%s model=%s asr_mode=%s asr_model=%s web_search=%s",
                 settings.gemma_provider, settings.gemma_model or "-", settings.gemma_asr_mode,
                 settings.gemma_asr_model or "-", "brave" if settings.brave_search_api_key else "off")
        yield
        await services.aclose()

    app = FastAPI(title="Cuevia private AI service", version=CONTRACT_VERSION, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.services = services
    app.add_exception_handler(AIServiceError, ai_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        incoming = request.headers.get("x-request-id", "")
        request.state.request_id = incoming[:64] if incoming.isascii() and incoming else uuid.uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    def require_token(request: Request) -> None:
        expected = settings.ai_service_token
        if not expected:
            raise AIServiceError(503, "SERVICE_NOT_CONFIGURED", "AI_SERVICE_TOKEN is not configured; refusing requests.")
        supplied = request.headers.get("x-internal-token", "")
        if not hmac.compare_digest(supplied.encode(), expected.encode()):
            raise AIServiceError(401, "UNAUTHORIZED", "Missing or invalid X-Internal-Token.")

    def svc(request: Request) -> Services:
        return request.app.state.services

    public = APIRouter(prefix="/internal/v1")
    private = APIRouter(prefix="/internal/v1", dependencies=[Depends(require_token)])

    @public.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", service=SERVICE_NAME, contract_version=CONTRACT_VERSION)

    @private.get("/capabilities")
    async def capabilities(request: Request) -> dict:
        """Diagnostics (not part of contract v1): which routes can actually run right now."""
        s = svc(request)
        problems = s.settings.validate()
        text = await s.gemma.verify_model() if s.settings.gemma_model else {"available": False}
        audio: dict = {"mode": s.settings.gemma_asr_mode, "model": s.settings.gemma_asr_model or None}
        if s.settings.asr_enabled:
            try:
                audio.update(await s.audio.capability())
            except AIServiceError as exc:
                audio.update({"audio": False, "detail": exc.message})
        else:
            audio["audio"] = False
        text_ok = text.get("available") is not False and s.settings.text_configured
        return {
            "contract_version": CONTRACT_VERSION,
            "text_model": text,
            "audio": audio,
            "web_search": "brave" if s.search.enabled else "disabled",
            "routes": {
                "profile": text_ok, "catch-up": text_ok, "explain": text_ok,
                "evaluate-question": text_ok, "match": text_ok,
                "transcribe": bool(audio.get("audio") is not False and s.settings.asr_enabled),
            },
            "config_problems": problems,
        }

    @private.post("/profile", response_model=ProfileResponse)
    async def profile(body: ProfileRequest, request: Request) -> ProfileResponse:
        return await build_profile(svc(request).gemma, body)

    @private.post("/transcribe", response_model=TranscribeResponse)
    async def transcribe(request: Request, file: UploadFile = File(...), language: str = Form("sr")) -> TranscribeResponse:
        s = svc(request)
        s.audio.ensure_configured()  # explicit AUDIO_UNAVAILABLE before reading the upload
        data = await file.read(s.settings.gemma_asr_max_bytes + 1)
        if len(data) > s.settings.gemma_asr_max_bytes:
            raise AIServiceError(413, "AUDIO_TOO_LARGE", "Audio upload exceeds GEMMA_ASR_MAX_BYTES.")
        wav, _ = normalize_audio(data, max_seconds=s.settings.gemma_asr_max_seconds)
        text, model_id = await s.audio.transcribe(wav, language.strip()[:20] or "sr")
        return TranscribeResponse(text=text, model_id=model_id)

    @private.post("/catch-up", response_model=CatchUpResponse)
    async def catch_up_route(body: CatchUpRequest, request: Request) -> CatchUpResponse:
        s = svc(request)
        return await catch_up(s.gemma, body, s.catch_up_cache)

    @private.post("/explain", response_model=ExplainResponse)
    async def explain_route(body: ExplainRequest, request: Request) -> ExplainResponse:
        s = svc(request)
        return await explain(s.gemma, s.search, body)

    @private.post("/evaluate-question", response_model=AIQuestionEvaluation)
    async def evaluate_route(body: EvaluateQuestionRequest, request: Request) -> AIQuestionEvaluation:
        return await evaluate_question(svc(request).gemma, body)

    @private.post("/match", response_model=MatchResponse)
    async def match_route(body: MatchRequest, request: Request) -> MatchResponse:
        return await match(svc(request).gemma, body)

    app.include_router(public)
    app.include_router(private)
    return app


def run() -> None:
    import os

    import uvicorn

    # Loopback by default; the Docker image sets AI_BIND_HOST=0.0.0.0 inside the private network.
    host = os.environ.get("AI_BIND_HOST", "127.0.0.1")
    uvicorn.run("cuevia_ai.main:create_app", factory=True, host=host, port=8001)


if __name__ == "__main__":
    run()
