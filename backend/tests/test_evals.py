from collections import Counter
from pathlib import Path

from evals.dataset import load_route_cases
from evals.scoring import score_route_results


DATASET = Path(__file__).parents[1] / "evals" / "datasets" / "routing_gold.json"


def test_routing_gold_dataset_has_fixed_balanced_splits():
    cases = load_route_cases(DATASET)

    assert len(cases) == 200
    assert Counter(case.split for case in cases) == {
        "development": 123,
        "calibration": 40,
        "test": 37,
    }
    assert {case.expected.scope for case in cases} == {
        "in_scope", "needs_clarification", "out_of_scope",
    }
    assert len({case.id for case in cases}) == len(cases)


def test_route_scorer_reports_false_rejection_clarification_and_calibration():
    results = [
        {
            "expected": {
                "scope": "needs_clarification", "intent": "clarification",
                "relation": "standalone", "targetKind": "none", "targetSource": "current",
                "targetTerms": [], "requestedData": [], "requiresResearch": False,
            },
            "predicted": {
                "scope": "needs_clarification", "intent": "clarification",
                "relation": "standalone", "targetKind": "none", "targetSource": "current",
                "targetTerms": [], "requestedData": [], "requiresResearch": False,
                "confidence": .6,
            },
            "latencyMs": 100,
            "history": [],
            "tags": ["clarification"],
        },
        {
            "expected": {
                "scope": "in_scope", "intent": "security_quote",
                "relation": "standalone", "targetKind": "security", "targetSource": "current",
                "targetTerms": ["贵州茅台"], "requestedData": ["quote"],
                "requiresResearch": False,
            },
            "predicted": {
                "scope": "out_of_scope", "intent": "out_of_scope",
                "relation": "standalone", "targetKind": "none", "targetSource": "current",
                "targetTerms": [], "requestedData": [], "requiresResearch": False,
                "confidence": .95,
            },
            "latencyMs": 300,
            "history": [{"role": "user", "content": "贵州茅台"}],
            "tags": ["quote"],
        },
    ]

    report = score_route_results(results)

    assert report["caseCount"] == 2
    assert report["clarificationRecall"] == 1
    assert report["falseRejectionRate"] == .5
    assert report["latencyMs"]["p95"] == 300
    assert report["latencyByStage"]["current"]["average"] == 100
    assert report["latencyByStage"]["contextual"]["average"] == 300
    assert report["confidence"]["buckets"]
    assert report["confidence"]["isotonic"]
