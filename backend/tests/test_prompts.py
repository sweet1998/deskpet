from app.prompts import (
    COMPLETION_INSTRUCTION,
    COMPLETION_MARKER,
    PROMPT_CONTRACT,
    STOCK_ROUTE_SYSTEM_PROMPT,
    build_research_prompt,
    build_role_system_prompt,
    build_trading_calendar_prompt,
)
from app.roles import get_role


def test_shared_contract_supplies_router_and_completion_prompts():
    assert PROMPT_CONTRACT["version"] == 8
    assert "strategy_backtest" in STOCK_ROUTE_SYSTEM_PROMPT
    assert "factors、backtest" in STOCK_ROUTE_SYSTEM_PROMPT
    assert STOCK_ROUTE_SYSTEM_PROMPT.endswith(PROMPT_CONTRACT["stockClarificationRouting"])
    assert "不得擅自降级为简单报价" in STOCK_ROUTE_SYSTEM_PROMPT
    assert "不得用低 confidence 的 out_of_scope 表示不确定" in STOCK_ROUTE_SYSTEM_PROMPT
    assert "存在多个可能目标" in STOCK_ROUTE_SYSTEM_PROMPT
    assert "sector_snapshot 只表示当前板块快照" in STOCK_ROUTE_SYSTEM_PROMPT
    assert "routingStage=current" in STOCK_ROUTE_SYSTEM_PROMPT
    assert "targetSource" in STOCK_ROUTE_SYSTEM_PROMPT
    assert COMPLETION_MARKER in COMPLETION_INSTRUCTION
    assert "回答必须完整表述" in COMPLETION_INSTRUCTION
    assert "所有观点说完后再结束输出" in COMPLETION_INSTRUCTION
    assert "如果内容较长，请完整分段输出" in COMPLETION_INSTRUCTION
    assert "严禁未说完就停止" in COMPLETION_INSTRUCTION


def test_role_system_prompt_combines_shared_sections():
    prompt = build_role_system_prompt(
        get_role("stock_expert"),
        "当前北京时间日期：2026年7月27日。",
        "小麦",
        ["偏好短回答"],
        build_research_prompt("sector", {"sector": "白酒"}, ["market-snapshot", "fact-verifier"]),
    )
    assert "你是麦麦的 A 股研究助手" in prompt
    assert "用户希望被称为：小麦。" in prompt
    assert "用户明确要求记住：偏好短回答" in prompt
    assert "本次问题意图：sector。" in prompt
    assert "market-snapshot, fact-verifier" in prompt
    assert "禁止声称没有执行工具" in prompt
    assert '{"sector":"白酒"}' in prompt


def test_trading_calendar_uses_shared_relative_time_rule():
    prompt = build_trading_calendar_prompt({
        "status": "ok",
        "source": "akshare",
        "today": {"date": "2026-07-27", "weekday": "星期一", "isTradingDay": True},
        "tomorrow": {"date": "2026-07-28", "weekday": "星期二", "isTradingDay": True},
        "nextTradingDay": {"date": "2026-07-28", "weekday": "星期二"},
    })
    assert prompt is not None
    assert "今天是A股交易日" in prompt
    assert PROMPT_CONTRACT["date"]["relativeTimeRule"] in prompt
