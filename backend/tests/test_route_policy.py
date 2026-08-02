from app.agent.route_policy import (
    build_execution_plan,
    normalize_route,
    reconcile_routes,
    route_needs_history,
    validate_research_result,
)
from app.agent.route_confidence import (
    apply_route_confidence_policy,
    route_execution_threshold,
)
from app.models import ChatMessage, ResearchPrepareResponse, StockRouteHint


def test_route_confidence_policy_uses_risk_specific_thresholds():
    ordinary = StockRouteHint(
        scope="in_scope", intent="security_trend", confidence=0.8,
    )
    decision = StockRouteHint(
        scope="in_scope", intent="decision", confidence=0.89,
    )
    rejected = StockRouteHint(
        scope="out_of_scope", intent="out_of_scope", confidence=0.89,
    )

    assert route_execution_threshold(ordinary) == 0.8
    assert route_execution_threshold(decision) == 0.9
    assert route_execution_threshold(rejected) == 0.9
    assert apply_route_confidence_policy(ordinary).scope == "in_scope"
    assert apply_route_confidence_policy(decision).scope == "needs_clarification"
    assert apply_route_confidence_policy(rejected).scope == "needs_clarification"


def test_native_clarification_route_is_never_blocked_by_confidence_policy():
    route = StockRouteHint(
        scope="needs_clarification",
        intent="security_trend",
        relation="followup",
        targetKind="security",
        confidence=0.2,
    )

    assert apply_route_confidence_policy(route) == route


def test_route_normalization_enforces_structural_intent_contracts():
    sector_scan = normalize_route(StockRouteHint(
        scope="in_scope",
        intent="sector_scan",
        targetKind="sector",
        requiresResearch=True,
        confidence=.95,
    ), "全市场板块排名", [])
    sector_followup = normalize_route(StockRouteHint(
        scope="in_scope",
        intent="security_trend",
        relation="followup",
        targetKind="sector",
        targetTerms=["半导体"],
        targetSource="history",
        requiresResearch=True,
        confidence=.9,
    ), "它为什么跌", [ChatMessage(role="user", content="看看半导体板块")])
    answer_followup = normalize_route(StockRouteHint(
        scope="in_scope",
        intent="answer_followup",
        relation="answer_explanation",
        targetKind="security",
        targetTerms=["贵州茅台"],
        targetSource="history",
        requestedData=["quote", "history"],
        confidence=.9,
    ), "为什么这么判断", [ChatMessage(role="user", content="分析贵州茅台")])

    assert sector_scan.targetKind == "market"
    assert sector_followup.intent == "sector"
    assert answer_followup.targetKind == "knowledge"
    assert answer_followup.targetTerms == []
    assert answer_followup.requestedData == []


def test_route_normalization_clarifies_ambiguous_history_targets():
    route = normalize_route(StockRouteHint(
        scope="in_scope",
        intent="valuation",
        relation="followup",
        targetKind="security",
        targetTerms=["宁德时代", "比亚迪"],
        targetSource="history",
        requiresResearch=True,
        confidence=.95,
    ), "它估值贵吗", [ChatMessage(role="user", content="对比宁德时代和比亚迪")])

    assert route.scope == "needs_clarification"
    assert route.intent == "clarification"
    assert route.targetSource == "history"
    assert route.targetTerms == []


def test_standalone_route_drops_targets_found_only_in_history():
    route = normalize_route(
        StockRouteHint(
            scope="in_scope",
            intent="comparison",
            relation="standalone",
            targetKind="security",
            targetTerms=["宁德时代", "贵州茅台"],
            requiresResearch=True,
            confidence=0.98,
        ),
        "分析近期板块趋势",
        [ChatMessage(role="user", content="对比宁德时代和贵州茅台")],
    )

    assert route.targetTerms == []
    assert route.targetSource == "current"


def test_followup_route_can_inherit_exact_history_target():
    route = normalize_route(
        StockRouteHint(
            scope="in_scope",
            intent="sector",
            relation="followup",
            targetKind="sector",
            targetTerms=["白酒", "新能源"],
            requiresResearch=True,
            confidence=0.96,
        ),
        "它的趋势怎么样",
        [ChatMessage(role="user", content="看看白酒板块")],
    )

    assert route.targetTerms == ["白酒"]
    assert route.targetSource == "history"


def test_targeted_route_without_current_target_requires_context_stage():
    route = normalize_route(
        StockRouteHint(
            scope="in_scope",
            intent="comparison",
            relation="standalone",
            targetKind="security",
            requiresResearch=True,
            confidence=0.91,
        ),
        "做个对比",
        [],
    )

    assert route_needs_history(route, has_history=True) is True


def test_conflicting_history_route_cannot_replace_current_semantic_task():
    current = StockRouteHint(
        scope="in_scope",
        intent="sector_scan",
        relation="standalone",
        targetKind="sector",
        targetSource="current",
        requiresResearch=True,
        confidence=0.97,
    )
    contextual = StockRouteHint(
        scope="in_scope",
        intent="comparison",
        relation="followup",
        targetKind="security",
        targetTerms=["宁德时代", "贵州茅台"],
        targetSource="history",
        requiresResearch=True,
        confidence=0.98,
    )

    assert reconcile_routes(current, contextual) == current


def test_unnamed_current_global_task_does_not_become_followup_without_history_dependency():
    current = StockRouteHint(
        scope="in_scope",
        intent="sector_scan",
        relation="standalone",
        targetKind="sector",
        targetSource="current",
        requiresResearch=True,
        confidence=0.97,
    )
    contextual = current.model_copy(update={"relation": "followup"})

    assert reconcile_routes(current, contextual) == current


def test_sector_scan_plan_uses_dedicated_read_only_tool():
    route = normalize_route(
        StockRouteHint(
            scope="in_scope",
            intent="sector_scan",
            relation="standalone",
            targetKind="sector",
            targetSource="current",
            requiresResearch=True,
            confidence=0.97,
        ),
        "分析近期板块趋势",
        [],
    )

    plan = build_execution_plan(route)

    assert plan is not None
    assert "scan_sectors" in plan.plannedTools
    assert "sector_ranking" in plan.requestedData


def test_result_validator_rejects_tool_context_for_another_target_kind():
    error = validate_research_result(
        StockRouteHint(
            scope="in_scope",
            intent="sector_scan",
            relation="standalone",
            targetKind="sector",
            targetSource="current",
            requiresResearch=True,
            confidence=0.97,
        ),
        ResearchPrepareResponse(
            scope="in_scope",
            intent="comparison",
            requiresResearch=True,
            targetKind="security",
            context={"kind": "security"},
        ),
    )

    assert error == "计划意图为 sector_scan，实际研究意图为 comparison"


def test_result_validator_accepts_decision_action_over_sector_research():
    error = validate_research_result(
        StockRouteHint(
            scope="in_scope",
            intent="decision",
            relation="standalone",
            targetKind="sector",
            targetTerms=["银行"],
            targetSource="current",
            requiresResearch=True,
            confidence=0.97,
        ),
        ResearchPrepareResponse(
            scope="in_scope",
            intent="sector",
            requiresResearch=True,
            targetKind="sector",
            context={"kind": "sector"},
        ),
    )

    assert error is None


def test_result_validator_still_rejects_decision_data_for_another_target_kind():
    error = validate_research_result(
        StockRouteHint(
            scope="in_scope",
            intent="decision",
            relation="standalone",
            targetKind="sector",
            targetTerms=["银行"],
            targetSource="current",
            requiresResearch=True,
            confidence=0.97,
        ),
        ResearchPrepareResponse(
            scope="in_scope",
            intent="decision",
            requiresResearch=True,
            targetKind="security",
            context={"kind": "security"},
        ),
    )

    assert error == "计划目标为 sector，实际研究目标为 security"
