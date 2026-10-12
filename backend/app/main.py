import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import errors, firebase, tasks
from .ai_client import get_ai
from .config import get_settings
from .routes import events, organizer, questions, recordings, sponsors

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

API_PREFIX = "/api/v1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    firebase.app()
    if get_settings().worker_enabled:
        tasks.start_worker()
    yield
    tasks.stop_worker()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Cuevia API", version="1", lifespan=lifespan)
    errors.install(app)
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origin_list, allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                       allow_headers=["Authorization", "Content-Type"], expose_headers=["X-Request-ID"])
    for r in (events.router, recordings.router, questions.router, sponsors.router, organizer.router):
        app.include_router(r, prefix=API_PREFIX)

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        # Public API stays up when AI is down; AI-dependent work reports pending/unavailable states.
        return {"status": "ok", "ai_available": get_ai().health()}

    return app


app = create_app()
