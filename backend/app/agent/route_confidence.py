from ..models import StockRouteHint


DEFAULT_EXECUTION_THRESHOLD = 0.80
OUT_OF_SCOPE_THRESHOLD = 0.90
HIGH_RISK_THRESHOLD = 0.90
LOW_RISK_THRESHOLD = 0.75

HIGH_RISK_INTENTS = {"decision", "stock_screen", "strategy_backtest"}
LOW_RISK_INTENTS = {"education", "role_capability"}


def route_execution_threshold(route: StockRouteHint) -> float:
    if route.scope == "needs_clarification":
        return 0.0
    if route.scope == "out_of_scope":
        return OUT_OF_SCOPE_THRESHOLD
    if route.intent in HIGH_RISK_INTENTS:
        return HIGH_RISK_THRESHOLD
    if route.intent in LOW_RISK_INTENTS:
        return LOW_RISK_THRESHOLD
    return DEFAULT_EXECUTION_THRESHOLD


def apply_route_confidence_policy(route: StockRouteHint) -> StockRouteHint:
    if route.scope == "needs_clarification":
        return route
    if route.confidence >= route_execution_threshold(route):
        return route
    return route.model_copy(update={
        "scope": "needs_clarification",
        "intent": "clarification",
        "targetKind": "none",
        "targetTerms": [],
        "targetSource": "none",
        "requestedData": [],
        "requiresResearch": False,
    })
