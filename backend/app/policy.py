"""Deterministic scoring/eligibility policy. Pure functions only; all numbers here stay private.

Prototype gate: sufficient context AND relevance >= gate_min_relevance AND expertise + depth > 0.
quality = (relevance + expertise + depth) / 3
topic_bonus = max(quality of good questions tagged with the topic), default 0, capped.
current_estimate = min(100, cv_baseline + topic_bonus) when baseline is known; unknown stays None.
Bonuses are recomputed from the full set of judgments every time, so re-evaluating a question
replaces its previous contribution instead of adding to it, and nothing can ever subtract.
"""
from dataclasses import dataclass

RANKING_VERSION = "rank-v1"


def norm_topic(topic: str) -> str:
    return " ".join(topic.casefold().split())


def effective_scores(j: dict) -> tuple[float, float, float] | None:
    """Scores after policy overrides, or None when the judgment carries no usable evidence."""
    if j.get("status") != "done" or j.get("context_status") != "sufficient":
        return None
    r, e, d = j.get("relevance"), j.get("expertise"), j.get("depth")
    if r is None or e is None or d is None:
        return None
    if j.get("is_generic_clarification"):
        e, d = 0.0, 0.0
    return float(r), float(e), float(d)


def is_good(j: dict, min_relevance: float) -> bool:
    s = effective_scores(j)
    return s is not None and s[0] >= min_relevance and (s[1] + s[2]) > 0


def quality(j: dict) -> float:
    r, e, d = effective_scores(j)
    return (r + e + d) / 3


def topic_bonuses(judgments: list[dict], min_relevance: float, cap: float) -> dict[str, float]:
    bonus: dict[str, float] = {}
    for j in judgments:
        if not is_good(j, min_relevance):
            continue
        q = max(0.0, min(cap, quality(j)))
        for t in {norm_topic(t["topic"]) for t in j.get("topics", [])}:
            bonus[t] = max(bonus.get(t, 0.0), q)
    return bonus


def current_estimates(baselines: dict[str, float | None], bonuses: dict[str, float]) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    for topic, base in baselines.items():
        t = norm_topic(topic)
        out[t] = None if base is None else min(100.0, float(base) + bonuses.get(t, 0.0))
    return out


def has_known_baseline(baselines: dict[str, float | None]) -> bool:
    return any(v is not None for v in baselines.values())


@dataclass(frozen=True)
class Candidate:
    participant_id: str
    estimates: dict[str, float | None]


def relevance_key(c: Candidate, opp_topics: list[str]) -> tuple[float, int] | None:
    """(best known relevant estimate, number of known relevant topics); None if no known relevant topic."""
    vals = [c.estimates.get(norm_topic(t)) for t in opp_topics]
    known = [v for v in vals if v is not None]
    if not known:
        return None
    return max(known), len(known)


def top_k(candidates: list[Candidate], opp_topics: list[str], k: int) -> list[Candidate]:
    """Deterministic ordering: best relevant estimate desc, coverage desc, participant_id asc."""
    keyed = [(relevance_key(c, opp_topics), c) for c in candidates]
    keyed = [(key, c) for key, c in keyed if key is not None]
    keyed.sort(key=lambda kc: (-kc[0][0], -kc[0][1], kc[1].participant_id))
    return [c for _, c in keyed[:k]]
