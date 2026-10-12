"""Live smoke test: backend AI client -> running private AI service (real Gemma behind it).

Usage (from repo root, AI service running):
  AI_SERVICE_URL=http://localhost:8001/internal/v1 AI_SERVICE_TOKEN=... backend/.venv/Scripts/python integration/smoke_ai.py
Each call's result is validated by the backend's own contract models; any failure exits non-zero.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.ai_client import AIClient, AIError  # noqa: E402

SEGMENTS = [{"id": "smoke-0", "sequence": 0, "start_ms": 0, "end_ms": 5000, "status": "ready",
             "text": "Transformeri koriste attention mehanizam da bi modelovali zavisnosti u sekvenci."}]


def main() -> int:
    ai = AIClient()
    if not ai.health():
        print("FAIL /health: service unreachable or contract_version != 1")
        return 1
    print("ok   /health")
    checks = {
        "/catch-up": lambda: ai.catch_up(SEGMENTS, "sr"),
        "/explain": lambda: ai.explain("attention", SEGMENTS, [], "simple", "sr"),
        "/evaluate-question": lambda: ai.evaluate_question(
            "Kako attention skalira sa duzinom sekvence?", SEGMENTS, "2026-10-10T12:03:00.000Z",
            "2026-10-10T12:00:00.000Z", ["Machine Learning"], "sr"),
        "/profile": lambda: ai.profile("Python inzenjer, 5 godina rada na ML sistemima i Kubernetes klasterima.",
                                       ["Machine Learning", "Cloud"]),
    }
    failed = 0
    for path, call in checks.items():
        t = time.perf_counter()
        try:
            r = call()
            print(f"ok   {path} model_id={r.model_id} ({time.perf_counter() - t:.1f}s)")
        except AIError as e:
            failed += 1
            print(f"FAIL {path}: {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
