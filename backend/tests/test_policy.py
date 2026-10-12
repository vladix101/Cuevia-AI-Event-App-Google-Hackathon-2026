from app.policy import Candidate, current_estimates, is_good, top_k, topic_bonuses


def j(r, e, d, topics=("ML",), ctx="sufficient", generic=False, status="done"):
    return {"status": status, "context_status": ctx, "relevance": r, "expertise": e, "depth": d,
            "is_generic_clarification": generic, "topics": [{"topic": t} for t in topics]}


def test_gate():
    assert is_good(j(6, 1, 0), 6)
    assert not is_good(j(5.9, 10, 10), 6)          # not relevant enough
    assert not is_good(j(10, 0, 0), 6)             # expertise + depth must be > 0
    assert not is_good(j(10, 8, 8, generic=True), 6)  # generic clarification forced to 0/0
    assert not is_good(j(None, None, None, ctx="insufficient"), 6)
    assert not is_good(j(9, 9, 9, status="failed"), 6)


def test_bonus_is_max_and_capped_and_never_negative():
    bonuses = topic_bonuses([j(9, 6, 6), j(10, 10, 10, topics=("ml",)), j(2, 0, 0), j(0, 0, 0)], 6, 10)
    assert bonuses == {"ml": 10.0}
    assert topic_bonuses([j(7, 1, 1)], 6, 2) == {"ml": 2.0}
    assert topic_bonuses([], 6, 10) == {}


def test_reevaluation_replaces_not_adds():
    first = topic_bonuses([j(9, 6, 6)], 6, 10)
    # same question re-judged: the judgment document is replaced, so bonus is recomputed, never summed
    second = topic_bonuses([j(7, 2, 3)], 6, 10)
    assert first == {"ml": 7.0} and second == {"ml": 4.0}


def test_estimates_unknown_baseline_stays_unknown_and_capped():
    est = current_estimates({"ML": 95.0, "Cloud": None, "Data": 40.0}, {"ml": 10.0, "cloud": 9.0})
    assert est == {"ml": 100.0, "cloud": None, "data": 40.0}


def test_bad_questions_never_reduce_baseline():
    bonuses = topic_bonuses([j(1, 0, 0), j(None, None, None, ctx="insufficient")], 6, 10)
    assert current_estimates({"ML": 50.0}, bonuses) == {"ml": 50.0}


def test_top_k_deterministic_and_domain_specific():
    cands = [Candidate("b", {"ml": 80.0}), Candidate("a", {"ml": 80.0}), Candidate("c", {"ml": 90.0}),
             Candidate("d", {"cloud": 99.0, "ml": None}), Candidate("e", {"ml": 80.0, "data": 10.0})]
    assert [c.participant_id for c in top_k(cands, ["ML"], 5)] == ["c", "a", "b", "e"]
    assert [c.participant_id for c in top_k(cands, ["ML", "Data"], 2)] == ["c", "e"]
    assert [c.participant_id for c in top_k(cands, ["Cloud"], 5)] == ["d"]
    assert top_k(cands, ["Security"], 5) == []
