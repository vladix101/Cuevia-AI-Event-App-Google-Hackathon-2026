"""Firestore-backed task queue for AI-dependent work (CV profiling, transcription, question judging).

Tasks are claimed in a transaction with a lease. If the process dies mid-task, the lease expires and
any worker reclaims it, so work survives restarts (in-memory queues would not). Attempts are bounded;
after the last attempt the kind-specific on_fail hook writes an honest terminal state.
"""
import logging
import threading
from dataclasses import dataclass
from datetime import timedelta
from typing import Callable

from . import firebase
from .config import get_settings
from .errors import ApiError

log = logging.getLogger("cuevia.tasks")


class Defer(Exception):
    """Not ready yet (e.g. transcript still processing); retry later without consuming an attempt."""

    def __init__(self, seconds: float):
        self.seconds = seconds


@dataclass
class Handler:
    run: Callable[[dict], None]
    on_fail: Callable[[dict, str], None]


HANDLERS: dict[str, Handler] = {}


def register(kind: str, run: Callable[[dict], None], on_fail: Callable[[dict, str], None]) -> None:
    HANDLERS[kind] = Handler(run, on_fail)


def _col():
    return firebase.db().collection("tasks")


def enqueue(task_id: str, kind: str, payload: dict, tx=None) -> None:
    doc = {"kind": kind, "payload": payload, "status": "pending", "attempts": 0,
           "not_before": firebase.now(), "lease_until": None, "last_error": None,
           "created_at": firebase.now()}
    ref = _col().document(task_id)
    if tx is not None:
        tx.set(ref, doc)
    else:
        ref.set(doc)
    wake()


def _claim(ref) -> dict | None:
    lease = timedelta(seconds=get_settings().task_lease_seconds)

    def txn(tx):
        snap = ref.get(transaction=tx)
        if not snap.exists:
            return None
        d = snap.to_dict()
        now = firebase.now()
        ready = (d["status"] == "pending" and d["not_before"] <= now) or (
            d["status"] == "running" and d["lease_until"] is not None and d["lease_until"] <= now)
        if not ready:
            return None
        tx.update(ref, {"status": "running", "lease_until": now + lease, "attempts": d["attempts"] + 1})
        return {**d, "attempts": d["attempts"] + 1}

    try:
        return firebase.run_transaction(txn, tries=3)
    except ApiError:
        return None  # another worker is claiming it


def _process(ref, task: dict) -> None:
    s = get_settings()
    handler = HANDLERS.get(task["kind"])
    if handler is None:
        ref.update({"status": "failed", "last_error": "unknown kind"})
        return
    try:
        handler.run(task["payload"])
    except Defer as d:
        ref.update({"status": "pending", "attempts": task["attempts"] - 1,
                    "not_before": firebase.now() + timedelta(seconds=d.seconds)})
        return
    except Exception as e:
        err = f"{type(e).__name__}: {e}"[:300]
        log.warning("task %s attempt %d failed: %s", ref.id, task["attempts"], err)
        if task["attempts"] >= s.task_max_attempts:
            try:
                handler.on_fail(task["payload"], err)
            finally:
                ref.update({"status": "failed", "last_error": err, "lease_until": None})
        else:
            backoff = min(60, 2 ** task["attempts"])
            ref.update({"status": "pending", "last_error": err, "lease_until": None,
                        "not_before": firebase.now() + timedelta(seconds=backoff)})
        return
    ref.update({"status": "done", "lease_until": None, "last_error": None})


def run_pending_once(limit: int = 50) -> int:
    """Claim and run every ready task once. Returns number of tasks processed."""
    done = 0
    for snap in _col().where("status", "in", ["pending", "running"]).limit(limit).stream():
        task = _claim(snap.reference)
        if task is not None:
            _process(snap.reference, task)
            done += 1
    return done


_wake = threading.Event()
_stop = threading.Event()


def wake() -> None:
    _wake.set()


def start_worker() -> threading.Thread:
    def loop():
        while not _stop.is_set():
            try:
                run_pending_once()
            except Exception:
                log.exception("worker loop error")
            _wake.wait(get_settings().worker_poll_seconds)
            _wake.clear()

    _stop.clear()
    t = threading.Thread(target=loop, name="cuevia-worker", daemon=True)
    t.start()
    return t


def stop_worker() -> None:
    _stop.set()
    _wake.set()
