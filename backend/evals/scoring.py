from collections import Counter
import math
from statistics import mean
from typing import Any, Dict, List, Optional, Sequence


SCOPE_LABELS = ("in_scope", "needs_clarification", "out_of_scope")
CONFIDENCE_BUCKETS = ((0, .2), (.2, .5), (.5, .7), (.7, .9), (.9, 1.000001))


def _safe_divide(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def _percentile(values: Sequence[float], percentile: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return ordered[index]


def _macro_f1(expected: Sequence[str], predicted: Sequence[str]) -> float:
    scores = []
    for label in SCOPE_LABELS:
        true_positive = sum(e == label and p == label for e, p in zip(expected, predicted))
        false_positive = sum(e != label and p == label for e, p in zip(expected, predicted))
        false_negative = sum(e == label and p != label for e, p in zip(expected, predicted))
        precision = _safe_divide(true_positive, true_positive + false_positive)
        recall = _safe_divide(true_positive, true_positive + false_negative)
        scores.append(_safe_divide(2 * precision * recall, precision + recall))
    return mean(scores)


def _collection_scores(results: List[Dict[str, Any]], field: str) -> Dict[str, float]:
    true_positive = 0
    expected_count = 0
    predicted_count = 0
    for result in results:
        expected_set = set(result["expected"].get(field) or [])
        predicted_set = set(result["predicted"].get(field) or [])
        true_positive += len(expected_set & predicted_set)
        expected_count += len(expected_set)
        predicted_count += len(predicted_set)
    precision = _safe_divide(true_positive, predicted_count)
    recall = _safe_divide(true_positive, expected_count)
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(_safe_divide(2 * precision * recall, precision + recall), 4),
    }


def _core_correct(expected: Dict[str, Any], predicted: Optional[Dict[str, Any]]) -> bool:
    if predicted is None:
        return False
    fields = ("scope", "intent", "relation", "targetKind", "targetSource", "requiresResearch")
    return all(expected.get(field) == predicted.get(field) for field in fields) and (
        set(expected.get("targetTerms") or []) == set(predicted.get("targetTerms") or [])
    )


def confidence_report(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    buckets = []
    calibration_error = 0.0
    usable = []
    for result in results:
        raw = result.get("rawPredicted") or result.get("predicted")
        if raw is not None:
            usable.append({**result, "calibrationRoute": raw})
    for low, high in CONFIDENCE_BUCKETS:
        selected = [
            result for result in usable
            if low <= float(result["calibrationRoute"].get("confidence") or 0) < high
        ]
        if not selected:
            continue
        accuracy = mean(
            _core_correct(result["expected"], result["calibrationRoute"])
            for result in selected
        )
        average_confidence = mean(
            float(result["calibrationRoute"].get("confidence") or 0)
            for result in selected
        )
        calibration_error += len(selected) / len(usable) * abs(accuracy - average_confidence)
        buckets.append({
            "range": [low, min(high, 1.0)],
            "count": len(selected),
            "averageConfidence": round(average_confidence, 4),
            "actualAccuracy": round(accuracy, 4),
        })
    return {
        "expectedCalibrationError": round(calibration_error, 4),
        "buckets": buckets,
        "isotonic": _fit_isotonic(usable),
    }


def _fit_isotonic(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[float, List[bool]] = {}
    for result in results:
        route = result["calibrationRoute"]
        confidence = round(float(route.get("confidence") or 0), 6)
        grouped.setdefault(confidence, []).append(
            _core_correct(result["expected"], route)
        )
    blocks = [
        {
            "minimum": confidence,
            "maximum": confidence,
            "correct": sum(values),
            "count": len(values),
        }
        for confidence, values in sorted(grouped.items())
    ]
    index = 0
    while index < len(blocks) - 1:
        left = blocks[index]
        right = blocks[index + 1]
        left_rate = _safe_divide(left["correct"], left["count"])
        right_rate = _safe_divide(right["correct"], right["count"])
        if left_rate <= right_rate:
            index += 1
            continue
        blocks[index:index + 2] = [{
            "minimum": left["minimum"],
            "maximum": right["maximum"],
            "correct": left["correct"] + right["correct"],
            "count": left["count"] + right["count"],
        }]
        index = max(0, index - 1)
    return [{
        "rawConfidenceRange": [block["minimum"], block["maximum"]],
        "calibratedProbability": round(_safe_divide(block["correct"], block["count"]), 4),
        "count": block["count"],
    } for block in blocks]


def score_route_results(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    expected_scopes = [result["expected"]["scope"] for result in results]
    predicted_scopes = [
        (result.get("predicted") or {}).get("scope", "missing")
        for result in results
    ]
    successful = [result for result in results if result.get("predicted") is not None]
    exact_fields = ("scope", "intent", "relation", "targetKind", "targetSource", "requiresResearch")
    metrics = {
        f"{field}Accuracy": round(mean(
            result["expected"].get(field) == result["predicted"].get(field)
            for result in successful
        ), 4) if successful else 0.0
        for field in exact_fields
    }
    target_scores = _collection_scores(successful, "targetTerms")
    data_scores = _collection_scores(successful, "requestedData")
    clarification_cases = [
        result for result in results if result["expected"]["scope"] == "needs_clarification"
    ]
    non_oos_cases = [result for result in results if result["expected"]["scope"] != "out_of_scope"]
    latencies = [float(result["latencyMs"]) for result in results if result.get("latencyMs") is not None]
    latency_by_stage = {}
    for stage, selected in {
        "current": [result for result in results if not result.get("history")],
        "contextual": [result for result in results if result.get("history")],
    }.items():
        values = [float(result["latencyMs"]) for result in selected if result.get("latencyMs") is not None]
        latency_by_stage[stage] = {
            "count": len(values),
            "average": round(mean(values), 2) if values else None,
            "p95": round(_percentile(values, .95), 2) if values else None,
        }
    tag_totals: Counter[str] = Counter()
    tag_correct: Counter[str] = Counter()
    for result in results:
        correct = _core_correct(result["expected"], result.get("predicted"))
        for tag in result.get("tags") or []:
            tag_totals[tag] += 1
            tag_correct[tag] += int(correct)
    return {
        "caseCount": len(results),
        "completedCount": len(successful),
        "errorCount": len(results) - len(successful),
        "routeExactMatch": round(mean(
            _core_correct(result["expected"], result.get("predicted"))
            for result in results
        ), 4) if results else 0.0,
        "scopeMacroF1": round(_macro_f1(expected_scopes, predicted_scopes), 4),
        **metrics,
        "targetTerms": target_scores,
        "requestedData": data_scores,
        "clarificationRecall": round(_safe_divide(
            sum((result.get("predicted") or {}).get("scope") == "needs_clarification" for result in clarification_cases),
            len(clarification_cases),
        ), 4),
        "falseRejectionRate": round(_safe_divide(
            sum((result.get("predicted") or {}).get("scope") == "out_of_scope" for result in non_oos_cases),
            len(non_oos_cases),
        ), 4),
        "falseExecutionRate": round(_safe_divide(
            sum(
                (result.get("predicted") or {}).get("scope") == "in_scope"
                and bool((result.get("predicted") or {}).get("requiresResearch"))
                for result in clarification_cases
            ),
            len(clarification_cases),
        ), 4),
        "latencyMs": {
            "average": round(mean(latencies), 2) if latencies else None,
            "p50": round(_percentile(latencies, .5), 2) if latencies else None,
            "p95": round(_percentile(latencies, .95), 2) if latencies else None,
        },
        "latencyByStage": latency_by_stage,
        "confidence": confidence_report(results),
        "tagAccuracy": {
            tag: round(_safe_divide(tag_correct[tag], count), 4)
            for tag, count in sorted(tag_totals.items())
        },
    }
