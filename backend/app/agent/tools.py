import json
from typing import Any, Dict, List

from ..market.service import MarketService


TOOL_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "name": "resolve_security",
        "description": "把 A 股代码或名称解析为标准证券标识；只读。",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string", "minLength": 1}},
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_market_context",
        "description": "获取 A 股个股行情、历史、财务以及可选的新闻公告研究上下文；只读。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1},
                "dailyCount": {"type": "integer", "minimum": 1, "maximum": 120, "default": 120},
                "includeEvents": {"type": "boolean", "default": False},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_company_news",
        "description": "获取指定 A 股公司最近新闻和法定公告，事件带 sourceId 和核验状态；只读。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1},
                "days": {"type": "integer", "minimum": 1, "maximum": 30, "default": 7},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "screen_stocks",
        "description": "按确定性规则筛选并评分 A 股候选，不构成推荐；只读。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "style": {
                    "type": "string",
                    "enum": ["balanced", "quality", "growth", "value", "momentum"],
                    "default": "balanced",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_market_overview",
        "description": "获取 A 股主要指数、涨跌家数、成交额和市场宽度；只读。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_data_lineage",
        "description": "返回研究数据来源、缓存与降级规则，供事实校验；只读。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


class ResearchTools:
    def __init__(self, market: MarketService):
        self.market = market

    async def call(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if name == "resolve_security":
            securities, candidates, warnings = await self.market.resolve_securities(str(arguments.get("query") or ""))
            return {"securities": securities, "candidates": candidates, "warnings": warnings}
        if name == "get_market_context":
            result = await self.market.context(
                str(arguments.get("query") or ""),
                max(1, min(120, int(arguments.get("dailyCount", 120)))),
                bool(arguments.get("includeEvents", False)),
            )
            return result.model_dump(exclude_none=True)
        if name == "get_company_news":
            return await self.market.security_events(
                str(arguments.get("query") or ""),
                int(arguments.get("days", 7)),
                int(arguments.get("limit", 10)),
            )
        if name == "screen_stocks":
            return await self.market.screen_stocks(
                str(arguments.get("style") or "balanced"),
                int(arguments.get("limit", 5)),
            )
        if name == "get_market_overview":
            return await self.market.market_overview()
        if name == "get_data_lineage":
            return {
                "kind": "data_lineage",
                "primaryProvider": self.market.provider.name,
                "fallbackProvider": self.market.fallback_provider.name if self.market.fallback_provider else None,
                "stockUniverseFallbackProvider": (
                    self.market.universe_fallback_provider.name
                    if self.market.universe_fallback_provider else None
                ),
                "policies": {
                    "toolFactsFirst": True,
                    "readOnly": True,
                    "staleDataMustBeDisclosed": True,
                    "newsRequiresSourceId": True,
                    "missingDataMustNotBeInvented": True,
                    "screenScoresAreSystemComputed": True,
                },
            }
        raise KeyError(name)

    @staticmethod
    def mcp_result(value: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
            "structuredContent": value,
        }
