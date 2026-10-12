"""Error type and handlers producing the shared error shape:
{"error":{"code":"CODE","message":"human-readable","request_id":"opaque-id"}}
"""

from __future__ import annotations

import logging
import uuid

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("cuevia_ai")


class AIServiceError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def request_id(request: Request) -> str:
    rid = getattr(request.state, "request_id", None)
    if not rid:
        rid = uuid.uuid4().hex
        request.state.request_id = rid
    return rid


def error_body(code: str, message: str, rid: str) -> dict:
    return {"error": {"code": code, "message": message, "request_id": rid}}


async def ai_error_handler(request: Request, exc: AIServiceError) -> JSONResponse:
    rid = request_id(request)
    log.warning("request failed rid=%s path=%s code=%s", rid, request.url.path, exc.code)
    return JSONResponse(error_body(exc.code, exc.message, rid), status_code=exc.status_code)


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    rid = request_id(request)
    # Report field locations and messages only; never echo submitted values (may contain CV text).
    details = "; ".join(
        f"{'.'.join(str(p) for p in e.get('loc', []))}: {e.get('msg', 'invalid')}" for e in exc.errors()[:10]
    )
    return JSONResponse(error_body("VALIDATION_ERROR", details or "Invalid request.", rid), status_code=422)


async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    rid = request_id(request)
    code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "HTTP_ERROR")
    return JSONResponse(error_body(code, str(exc.detail), rid), status_code=exc.status_code)


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    rid = request_id(request)
    log.exception("unhandled error rid=%s path=%s", rid, request.url.path)
    return JSONResponse(error_body("INTERNAL_ERROR", "Internal error.", rid), status_code=500)
