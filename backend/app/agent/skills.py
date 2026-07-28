from dataclasses import dataclass
from typing import Dict, Tuple

from ..models import StockIntent


@dataclass(frozen=True)
class ResearchSkill:
    id: str
    name: str
    required_tools: Tuple[str, ...]


SKILLS: Dict[str, ResearchSkill] = {
    "market-snapshot": ResearchSkill(
        "market-snapshot",
        "行情快照",
        ("resolve_security", "get_market_context"),
    ),
    "news-event-research": ResearchSkill(
        "news-event-research",
        "新闻事件研究",
        ("get_company_news",),
    ),
    "company-deep-research": ResearchSkill(
        "company-deep-research",
        "公司深度研究",
        ("get_market_context",),
    ),
    "stock-screener": ResearchSkill(
        "stock-screener",
        "全市场个股筛选",
        ("screen_stocks",),
    ),
    "stock-comparison": ResearchSkill(
        "stock-comparison",
        "个股横向比较",
        ("get_market_context",),
    ),
    "decision-framework": ResearchSkill(
        "decision-framework",
        "结构化决策框架",
        ("get_market_context", "get_company_news"),
    ),
    "fact-verifier": ResearchSkill(
        "fact-verifier",
        "事实与引用校验",
        ("get_data_lineage",),
    ),
}


INTENT_SKILLS: Dict[str, Tuple[str, ...]] = {
    "security_quote": ("market-snapshot",),
    "security_trend": ("market-snapshot", "company-deep-research", "news-event-research"),
    "security_news": ("news-event-research", "market-snapshot"),
    "fundamental": ("company-deep-research", "news-event-research"),
    "valuation": ("company-deep-research", "market-snapshot"),
    "comparison": ("stock-comparison", "company-deep-research"),
    "stock_screen": ("stock-screener", "fact-verifier"),
    "decision": (
        "market-snapshot",
        "company-deep-research",
        "news-event-research",
        "decision-framework",
        "fact-verifier",
    ),
    "sector_snapshot": ("market-snapshot",),
    "sector": ("market-snapshot",),
    "sector_scan": ("market-snapshot",),
    "index": ("market-snapshot",),
    "market_snapshot": ("market-snapshot",),
    "market": ("market-snapshot",),
}


def skills_for_intent(intent: StockIntent, requires_research: bool) -> list[str]:
    selected = list(INTENT_SKILLS.get(intent, ()))
    if requires_research and "fact-verifier" not in selected:
        selected.append("fact-verifier")
    return selected
