import re
from typing import Dict, Iterable, List, Optional

from ..models import (
    ChatMessage,
    ResearchExecutionPlan,
    ResearchPrepareResponse,
    StockIntent,
    StockResearchData,
    StockRouteHint,
)
from .skills import tools_for_intent


_SELF_CONTAINED_INTENTS = {
    "stock_screen",
    "strategy_backtest",
    "sector_scan",
    "market_snapshot",
    "market",
    "education",
    "role_capability",
    "out_of_scope",
}

_DEFAULT_DATA_BY_INTENT: Dict[str, tuple[StockResearchData, ...]] = {
    "security_quote": ("quote",),
    "security_trend": ("quote", "history", "news"),
    "security_news": ("news", "announcements", "quote"),
    "fundamental": ("financial", "news"),
    "valuation": ("valuation", "financial", "quote"),
    "comparison": ("quote", "history", "financial", "valuation"),
    "stock_screen": ("quote", "financial", "valuation", "history", "data_lineage"),
    "strategy_backtest": ("history", "factors", "backtest", "data_lineage"),
    "decision": ("quote", "history", "financial", "valuation", "news", "data_lineage"),
    "sector_snapshot": ("quote", "constituents"),
    "sector": ("quote", "history", "constituents"),
    "sector_scan": ("sector_ranking", "history", "market_breadth", "data_lineage"),
    "index": ("quote", "history"),
    "market_snapshot": ("market_breadth",),
    "market": ("market_breadth", "history"),
}

_EXPECTED_CONTEXT_KINDS: Dict[str, set[str]] = {
    "security_quote": {"security"},
    "security_trend": {"security"},
    "security_news": {"security"},
    "fundamental": {"security"},
    "valuation": {"security"},
    "comparison": {"security"},
    "decision": {"security"},
    "stock_screen": {"stock_screen", "factor_screen"},
    "strategy_backtest": {"strategy_backtest"},
    "sector_snapshot": {"sector", "sector_group"},
    "sector": {"sector", "sector_group"},
    "sector_scan": {"sector_scan"},
    "index": {"index"},
    "market_snapshot": {"market"},
    "market": {"market"},
}


def _normalize(value: str) -> str:
    return re.sub(r"[\s，。！？、,.!?：:；;（）()\[\]【】\"'“”‘’]+", "", value).casefold()


def _terms_in_material(terms: Iterable[str], material: str) -> List[str]:
    normalized_material = _normalize(material)
    return [term for term in terms if _normalize(term) and _normalize(term) in normalized_material]


def normalize_route(
    route: StockRouteHint,
    text: str,
    history: List[ChatMessage],
) -> StockRouteHint:
    current_terms = _terms_in_material(route.targetTerms, text)
    history_material = "\n".join(item.content for item in history)
    history_terms = _terms_in_material(route.targetTerms, history_material)

    if current_terms:
        target_terms = current_terms
        target_source = "current"
    elif route.relation in {"followup", "answer_explanation"} and history_terms:
        target_terms = history_terms
        target_source = "history"
    elif (
        route.relation in {"followup", "answer_explanation"}
        and route.targetSource == "history"
        and history
    ):
        target_terms = []
        target_source = "history"
    else:
        target_terms = []
        target_source = "current" if route.relation in {"standalone", "new_topic"} else "none"

    requested_data = route.requestedData or list(_DEFAULT_DATA_BY_INTENT.get(route.intent, ()))
    return route.model_copy(update={
        "targetTerms": target_terms,
        "targetSource": target_source,
        "requestedData": requested_data,
    })


def route_needs_history(route: Optional[StockRouteHint], has_history: bool) -> bool:
    if not has_history or route is None:
        return False
    if route.scope == "needs_clarification" or route.intent in {"clarification", "answer_followup"}:
        return True
    if route.targetSource == "history" or route.relation == "answer_explanation":
        return True
    if route.intent in _SELF_CONTAINED_INTENTS:
        return False
    if route.targetKind in {"security", "sector", "index"} and not route.targetTerms:
        return True
    return route.relation == "followup" and not route.targetTerms


def prefer_current_route(route: StockRouteHint) -> bool:
    if route.scope == "out_of_scope":
        return True
    if route.scope != "in_scope":
        return False
    if route.intent in _SELF_CONTAINED_INTENTS:
        return True
    if route.intent == "answer_followup":
        return False
    return route.targetSource == "current" and bool(route.targetTerms)


def reconcile_routes(
    current: Optional[StockRouteHint],
    contextual: Optional[StockRouteHint],
) -> Optional[StockRouteHint]:
    if contextual is None:
        return current
    if current is None:
        return contextual
    if contextual.relation in {"standalone", "new_topic"} and prefer_current_route(contextual):
        return contextual
    if contextual.relation in {"followup", "answer_explanation"}:
        same_current_target = (
            contextual.targetSource == "current"
            and current.targetSource == "current"
            and contextual.targetKind == current.targetKind
            and bool(current.targetTerms)
            and contextual.targetTerms == current.targetTerms
        )
        valid_history_dependency = (
            contextual.targetSource == "history"
            and contextual.intent == current.intent
            and contextual.targetKind == current.targetKind
        )
        if same_current_target or valid_history_dependency or not prefer_current_route(current):
            return contextual
        return current
    return current if prefer_current_route(current) else contextual


def build_execution_plan(route: Optional[StockRouteHint]) -> Optional[ResearchExecutionPlan]:
    if route is None:
        return None
    return ResearchExecutionPlan(
        relation=route.relation,
        targetSource=route.targetSource,
        requestedData=route.requestedData,
        plannedTools=tools_for_intent(route.intent, route.requiresResearch),
        timeRangeDays=route.timeRangeDays,
    )


def validate_research_result(
    route: Optional[StockRouteHint],
    prepared: ResearchPrepareResponse,
) -> Optional[str]:
    if route is None or prepared.scope != "in_scope" or not prepared.requiresResearch:
        return None
    if route.targetSource == "history" and route.relation not in {"followup", "answer_explanation"}:
        return "历史目标只能用于明确追问"
    if route.intent != prepared.intent:
        return f"计划意图为 {route.intent}，实际研究意图为 {prepared.intent}"
    expected = _EXPECTED_CONTEXT_KINDS.get(route.intent)
    if not expected:
        return None
    context_kind = str((prepared.context or {}).get("kind") or "")
    if context_kind not in expected:
        return f"计划需要 {route.intent}，工具返回 {context_kind or '空结果'}"
    return None
