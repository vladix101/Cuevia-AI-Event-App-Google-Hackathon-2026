"""Firebase Admin initialisation. Admin SDK bypasses security rules: every route checks authorization in code."""
import os
import random
import time
from datetime import datetime, timezone
from functools import lru_cache
from typing import Callable

import firebase_admin
from firebase_admin import credentials, firestore
from google.api_core.exceptions import Aborted
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore as gcf

from .config import get_settings
from .errors import ApiError


class _EmulatorCredential(credentials.Base):
    """Emulators accept unauthenticated clients; avoids requiring ADC on developer machines and CI."""

    def get_credential(self):
        return AnonymousCredentials()


@lru_cache
def app() -> firebase_admin.App:
    s = get_settings()
    if s.google_application_credentials:
        cred = credentials.Certificate(s.google_application_credentials)
    elif os.environ.get("FIRESTORE_EMULATOR_HOST"):
        cred = _EmulatorCredential()
    else:
        cred = None  # Application Default Credentials (e.g. Cloud Run service account)
    return firebase_admin.initialize_app(
        cred, {"projectId": s.firebase_project_id}
    )


def db():
    return firestore.client(app())


def run_transaction(fn: Callable, tries: int = 10):
    """Runs fn(tx) in a Firestore transaction, retrying contention with jittered exponential backoff.

    The client library's own retries are immediate, so many concurrent writers of one document keep
    colliding. Exceptions raised by fn itself (e.g. ApiError) propagate unchanged.
    """
    for attempt in range(tries):
        try:
            return gcf.transactional(fn)(db().transaction(max_attempts=1))
        except (Aborted, ValueError) as e:  # ValueError: "Failed to commit transaction in 1 attempts"
            if isinstance(e, ValueError) and "Failed to commit" not in str(e):
                raise
            time.sleep(random.uniform(0, min(1.0, 0.02 * 2 ** attempt)))

    raise ApiError(503, "BUSY", "Too much concurrent activity; retry the request")


def now() -> datetime:
    return datetime.now(timezone.utc)


def rfc3339(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
