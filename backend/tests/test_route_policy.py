from app.agent.route_policy import (
    build_execution_plan,
    normalize_route,
    reconcile_routes,
    route_needs_history,
    validate_research_result,
)
from app.models import ChatMessage, ResearchPrepareResponse, StockRouteHint


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
