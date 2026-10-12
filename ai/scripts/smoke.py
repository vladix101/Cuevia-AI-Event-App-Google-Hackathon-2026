"""Smoke test against a RUNNING service backed by the REAL configured Gemma provider.

Usage (from ai/):
    python scripts/smoke.py                         # text routes
    python scripts/smoke.py --audio path/to/clip.wav # + /transcribe with a clip you supply

Records actual status, latency and error codes per route. Nothing is faked: a route that fails
is reported as failed, and /transcribe is reported as skipped when no audio file is supplied.
Reads AI_SERVICE_TOKEN from the environment or ai/.env. Never prints the token.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values

AI_DIR = Path(__file__).resolve().parent.parent
FIX = AI_DIR / "tests" / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8001/internal/v1")
    ap.add_argument("--audio", type=Path, help="WAV/other clip (<=30 s) to send to /transcribe")
    ap.add_argument("--language", default="en")
    ap.add_argument("--timeout", type=float, default=300)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    import os

    token = os.environ.get("AI_SERVICE_TOKEN") or dotenv_values(AI_DIR / ".env").get("AI_SERVICE_TOKEN") or ""
    headers = {"X-Internal-Token": token}
    seg = load("transcript_segments.json")["segments"]
    cv = load("cv_sample.json")
    q = load("questions.json")
    opp = load("opportunity.json")
    src = load("sources.json")

    def judge(text: str, context: bool = True) -> dict:
        return {"question_text": text, "segments": seg, "submitted_at": q["submitted_at"],
                "window_start_at": q["window_start_at"], "allowed_topics": q["allowed_topics"],
                "context_available": context, "locale": "sr"}

    calls: list[tuple[str, str, str, dict | None]] = [
        ("health", "GET", "/health", None),
        ("capabilities", "GET", "/capabilities", None),
        ("profile", "POST", "/profile", {"cv_text": cv["cv_text"], "event_topics": cv["event_topics"]}),
        ("catch-up", "POST", "/catch-up", {"segments": seg, "locale": "sr"}),
        ("explain", "POST", "/explain", {"term": "HNSW", "segments": seg, "depth": "simple", "locale": "sr",
                                          "background": [{"topic": "Vector databases", "baseline": 20,
                                                          "uncertainty": "medium", "evidence": []}],
                                          "provided_sources": src["provided_sources"]}),
        ("evaluate-question:good", "POST", "/evaluate-question", judge(q["good"])),
        ("evaluate-question:generic", "POST", "/evaluate-question", judge(q["generic"])),
        ("evaluate-question:injection", "POST", "/evaluate-question", judge(q["injection"])),
        ("evaluate-question:no-context", "POST", "/evaluate-question", judge(q["good"], context=False)),
        ("match", "POST", "/match", {k: opp[k] for k in ("opportunity", "profile_evidence", "questions")}),
    ]

    report = []
    with httpx.Client(base_url=args.base_url, headers=headers, timeout=args.timeout) as client:
        for name, method, path, body in calls:
            t0 = time.perf_counter()
            try:
                r = client.request(method, path, json=body)
                entry = {"route": name, "status": r.status_code, "latency_ms": int((time.perf_counter() - t0) * 1000),
                         "body": r.json()}
            except Exception as exc:  # report, never hide
                entry = {"route": name, "status": None, "latency_ms": int((time.perf_counter() - t0) * 1000),
                         "error": f"{type(exc).__name__}: {exc}"}
            report.append(entry)
            print(f"{name:32s} status={entry['status']} latency_ms={entry['latency_ms']}", file=sys.stderr)

        if args.audio:
            t0 = time.perf_counter()
            with args.audio.open("rb") as fh:
                r = client.post("/transcribe", files={"file": (args.audio.name, fh, "application/octet-stream")},
                                data={"language": args.language})
            entry = {"route": "transcribe", "status": r.status_code,
                     "latency_ms": int((time.perf_counter() - t0) * 1000), "body": r.json(),
                     "note": f"input clip: {args.audio.name} (supplied by operator)"}
            print(f"{'transcribe':32s} status={entry['status']} latency_ms={entry['latency_ms']}", file=sys.stderr)
        else:
            entry = {"route": "transcribe", "status": None, "skipped": "no --audio clip supplied"}
        report.append(entry)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    failed = [e["route"] for e in report if e.get("status") not in (200, None) or e.get("error")]
    print(f"failed routes: {failed or 'none'}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
