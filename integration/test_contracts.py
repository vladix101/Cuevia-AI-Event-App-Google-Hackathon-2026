"""Static contract checks: contracts/*.md <-> backend Pydantic models and routes.

Run from repo root with the backend venv:  backend/.venv/Scripts/python -m pytest integration -q
(No emulator needed: only schemas and the OpenAPI route table are inspected.)
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("WORKER_ENABLED", "false")

from app import ai_client, schemas  # noqa: E402
from app.main import app  # noqa: E402

HTTP = (ROOT / "contracts" / "http-v1.md").read_text(encoding="utf-8")
AI = (ROOT / "contracts" / "ai-v1.md").read_text(encoding="utf-8")


def contract_types(text: str) -> dict[str, list[str]]:
    """Parses 'Name = {a:type,b:type}' definitions (possibly multi-line) into top-level key lists."""
    out = {}
    for m in re.finditer(r"^(\w+) = \{", text, re.M):
        i, depth = m.end() - 1, 0
        for j in range(i, len(text)):
            depth += {"{": 1, "}": -1}.get(text[j], 0)
            if depth == 0:
                break
        body, keys, depth, cur = text[i + 1:j], [], 0, ""
        for ch in body + ",":
            if ch in "{[(":
                depth += 1
            elif ch in "}])":
                depth -= 1
            if ch == "," and depth == 0:
                keys.append(cur.split(":")[0].strip())
                cur = ""
            else:
                cur += ch
        out[m.group(1)] = [k for k in keys if k]
    return out


def fields(model) -> list[str]:
    return list(model.model_fields)


def test_public_types_match_contract():
    types = contract_types(HTTP)
    for name in ["Segment", "Interest", "ProfilePublic", "QuestionPublic", "Source", "CatchUp", "Explanation"]:
        assert fields(getattr(schemas, name)) == types[name], name


def test_private_types_match_contract():
    types = contract_types(AI)
    assert fields(ai_client.TopicEvidence) == types["TopicEvidence"]
    assert fields(ai_client.AIQuestionEvaluation) == types["AIQuestionEvaluation"]


def test_routes_match_contract():
    declared = set()
    for method, path in re.findall(r"^(GET|POST|PUT|PATCH|DELETE) (/[^\s?]+)", HTTP, re.M):
        declared.add((method, "/api/v1" + path))
    implemented = {(m.upper(), p) for p, ops in app.openapi()["paths"].items() for m in ops}
    assert declared == implemented


def test_public_schemas_carry_no_private_fields():
    banned = {"cv_baseline", "baseline", "relevance", "expertise", "depth", "quality", "bonus", "score", "scores", "rank"}
    for name in dir(schemas):
        model = getattr(schemas, name)
        if isinstance(model, type) and issubclass(model, schemas.Public):
            # ExplainRequest.depth is the requested explanation level (simple/standard/advanced), not a score.
            allowed = {"depth"} if model is schemas.ExplainRequest else set()
            assert not (banned - allowed) & set(model.model_fields), name
            assert model.model_config.get("extra") == "forbid", name


def test_samples_validate():
    samples = json.loads((ROOT / "integration" / "samples.json").read_text(encoding="utf-8"))
    for name, payload in samples["public"].items():
        getattr(schemas, name).model_validate(payload)
    for name, payload in samples["private"].items():
        getattr(ai_client, name).model_validate(payload)
