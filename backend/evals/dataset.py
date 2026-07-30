from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Dict, List

from app.models import ChatMessage, StockRouteHint


@dataclass(frozen=True)
class RouteEvalCase:
    id: str
    split: str
    text: str
    history: List[ChatMessage]
    expected: StockRouteHint
    tags: List[str]


def _merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    output = dict(base)
    output.update(override)
    return output


def load_route_cases(path: Path) -> List[RouteEvalCase]:
    with path.open("r", encoding="utf-8") as source:
        payload = json.load(source)
    cases: List[RouteEvalCase] = []
    seen = set()
    for group in payload.get("groups", []):
        group_id = str(group["id"])
        base_expected = dict(group["expected"])
        base_history = list(group.get("history") or [])
        base_tags = [str(item) for item in group.get("tags") or []]
        for index, value in enumerate(group.get("cases") or [], start=1):
            item = {"text": value} if isinstance(value, str) else dict(value)
            case_id = str(item.get("id") or f"{group_id}-{index:03d}")
            if case_id in seen:
                raise ValueError(f"重复的评测样本 ID：{case_id}")
            seen.add(case_id)
            expected = _merge(base_expected, dict(item.get("expected") or {}))
            expected.setdefault("confidence", 1)
            cases.append(RouteEvalCase(
                id=case_id,
                split=str(item.get("split") or group["split"]),
                text=str(item["text"]),
                history=[
                    ChatMessage.model_validate(message)
                    for message in item.get("history", base_history)
                ],
                expected=StockRouteHint.model_validate(expected),
                tags=list(dict.fromkeys([*base_tags, *item.get("tags", [])])),
            ))
    expected_count = payload.get("expectedCaseCount")
    if expected_count is not None and len(cases) != int(expected_count):
        raise ValueError(f"评测集声明 {expected_count} 条，实际展开为 {len(cases)} 条")
    return cases
