import asyncio
from datetime import date, timedelta
import re
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .agent.skills import skills_for_intent
from .agent.tools import ResearchTools
from .market.service import CODE_PATTERN, MarketService, search_terms
from .models import (
    ClarificationCard,
    ClarificationOption,
    ResearchPrepareRequest,
    ResearchPrepareResponse,
    ResearchTarget,
    StockIntent,
)

if TYPE_CHECKING:
    from .quant.service import QuantService


CLARIFY_MESSAGE = "请补充具体的六位股票代码、股票名称、板块或指数名称。"
ProgressCallback = Callable[[str], Awaitable[None]]
ROUTE_HINT_CONFIDENCE = 0.72

# 路由信号分三层，权威顺序：Tier A 高精度确定信号 > 高置信 routeHint（Qwen3 模型）> Tier C 兜底关键词。
#   Tier A —— 高精度确定信号（权威，始终可信）：CODE_PATTERN（来自 market）、INDEXES、SECTOR_THEMES、
#             以及显式的“板块/行业/概念/指数”标记。命中即可确定路由，无需模型。
#   Tier B —— 域内深度提示（启发式，低风险）：仅在“已确定在范围内”后区分快照 vs 深度研究、
#             基本面 vs 估值等，判错代价小。
#   Tier C —— 范围闸门兜底（仅在没有高置信 routeHint 时才作准）：判定是否越界/知识/身份/追问。
#             中文表达变体无穷，这些列表必然有缺口，因此当模型给出高置信 routeHint 时以模型为准，
#             这些关键词只作为模型缺席或低置信时的 fallback。

# --- Tier C：范围闸门兜底 ---
OUT_OF_SCOPE_KEYWORDS = (
    "天气", "气温", "下雨", "空气质量", "菜谱", "做饭", "翻译", "写诗", "小说", "电影", "音乐",
    "旅游", "酒店", "机票", "星座", "编程", "程序", "vue", "react", "javascript", "python", "数据库",
    "基金", "债券", "期货", "外汇", "比特币", "加密货币", "美股", "港股",
)
EDUCATION_KEYWORDS = (
    "市盈率", "市净率", "roe", "k线", "复权", "分红", "财报", "换手率", "量比", "基本面",
    "技术面", "仓位", "止损", "估值", "涨停", "跌停", "打新", "牛市", "熊市", "成交量",
    "pe", "pb", "peg", "ps", "macd", "rsi", "均线", "股息率", "除权", "除息", "集合竞价", "龙虎榜",
    "融资融券", "每股收益", "净资产收益率", "自由现金流", "量价关系", "市销率", "市值", "股本",
    "停牌", "退市", "分时图", "盘口", "北向资金", "选股", "打板", "做t", "t+1",
)
EDUCATION_QUESTION_WORDS = (
    "什么是", "什么意思", "是什么意思", "怎么理解", "如何理解", "含义", "区别", "解释一下",
    "怎么算", "怎么计算", "计算方法", "有什么用", "高好还是低好", "越高越好吗", "为什么会",
    "代表什么", "怎么看", "怎么选", "怎么做",
)
# --- Tier B：域内深度提示（区分快照/研究/基本面/估值等，已在范围内才使用）---
MARKET_KEYWORDS = (
    "大盘", "a股市场", "全市场", "涨跌家数", "市场情绪", "市场宽度", "两市成交", "赚钱效应",
    "市场风格", "成交额", "北向资金",
)
GENERIC_MARKET_KEYWORDS = (
    "行情", "盘面", "股市", "市场", "市场表现", "市场涨跌", "市场怎么样", "a股", "大a", "两市",
)
GENERIC_MARKET_TARGETS = ("行情", "盘面", "股市", "市场", "大盘", "a股", "大a", "两市")
SECTOR_SCAN_KEYWORDS = (
    "哪些板块", "什么板块", "哪个板块", "板块排名", "板块排行", "板块筛选", "领涨板块", "走强板块",
    "哪些行业", "什么行业", "哪个行业", "行业排名", "行业排行", "行业筛选", "领涨行业", "走强行业",
)
GENERIC_SCAN_TARGETS = ("行情", "方向", "赛道", "题材", "主题")
GENERIC_SCAN_MOVES = ("上涨", "上升", "走强", "强势", "向上", "表现好", "机会")
GENERIC_SCAN_QUESTIONS = ("什么", "哪些", "哪个")
FUNDAMENTAL_KEYWORDS = ("基本面", "财报", "营收", "利润", "现金流", "roe", "负债", "成长性")
VALUATION_KEYWORDS = ("估值", "市盈率", "市净率", "pe", "pb", "贵不贵", "便宜")
TREND_KEYWORDS = (
    "趋势", "走势", "近期", "最近", "分析", "为什么", "原因", "风险", "展望", "技术面", "支撑", "压力",
    "后市", "接下来", "前景", "回撤", "持续性",
)
RESEARCH_DEPTH_KEYWORDS = TREND_KEYWORDS + (
    "持续", "后续", "未来", "逻辑", "驱动", "影响", "怎么看", "值得关注", "机会", "对比", "比较",
)
SNAPSHOT_KEYWORDS = (
    "今天", "今日", "当日", "现在", "当前", "盘中", "收盘", "行情", "盘面", "表现", "涨跌", "怎么样", "如何",
    "咋样", "什么情况", "怎么走", "红还是绿", "涨还是跌", "强不强", "好吗", "好不好", "还好吗",
    "咋回事", "怎么了", "整体如何", "热不热", "弱不弱", "有啥变化",
)
ROUTING_NOISE_TERMS = (
    GENERIC_MARKET_TARGETS + MARKET_KEYWORDS + RESEARCH_DEPTH_KEYWORDS + SNAPSHOT_KEYWORDS
    + GENERIC_SCAN_MOVES + GENERIC_SCAN_QUESTIONS
    + ("走弱", "走低", "下行", "震荡", "情况", "怎样", "好吗", "好不好", "还好吗", "咋回事", "怎么了")
)
QUOTE_KEYWORDS = ("多少钱", "当前价格", "现在价格", "股价", "涨跌幅", "现价", "当前点位", "现在点位")
NEWS_KEYWORDS = ("新闻", "消息面", "公告", "舆情", "事件", "最新消息", "利好", "利空")
DECISION_KEYWORDS = (
    "能买吗", "要不要买", "该不该买", "值得买吗", "买入", "卖出", "要不要卖", "该不该卖",
    "持有还是卖", "继续持有", "加仓", "减仓", "止盈", "止损", "怎么操作",
)
SCREEN_KEYWORDS = (
    "筛选优质股票", "筛选股票", "筛选个股", "选出优质股票", "选出几只", "推荐几只",
    "哪些股票值得关注", "优质股票", "优质个股",
)

# --- Tier C：指代/新话题/上下文追问识别（范围闸门兜底，模型高置信时以模型为准）---
REFERENCE_WORDS = (
    "它", "那", "那么", "那只", "这只", "该股", "这个板块", "该板块", "这个指数", "其", "今天呢", "现在呢",
)
NEW_TOPIC_WORDS = (
    "换个话题", "换一个话题", "说点别的", "聊点别的", "不聊这个了", "不说这个了",
    "忽略前面", "不用管前面", "忘掉前面", "重新开始", "新话题", "另一个问题", "另外一个问题",
)
COMPARISON_WORDS = ("对比", "比较", "相比", "vs", "VS")
CONTEXT_ONLY_WORDS = (
    "为什么", "什么原因", "怎么回事", "怎么看", "为何", "怎么", "最近", "近期", "这段时间",
    "今天", "现在", "目前", "接下来", "后续", "后面", "这么", "那么", "如此", "特别", "厉害",
    "严重", "大幅", "持续", "一直", "突然", "是不是", "有没有", "上涨", "下跌", "大涨", "大跌",
    "走强", "走弱", "走高", "走低", "回撤", "反弹", "涨", "跌", "风险", "估值", "基本面",
    "财报", "趋势", "走势", "支撑", "压力", "后市", "前景", "它", "那只", "这只", "该股",
    "这个板块", "该板块", "这个指数", "这个", "那么", "那", "其", "很", "太", "又", "还",
    "继续分析", "继续看看", "继续", "接着说", "接着", "展开说说", "展开", "详细说说", "详细说",
    "查一下", "查查", "帮我查", "看看", "看一下", "说说", "讲讲", "要", "可以", "好的", "好",
    "行", "嗯", "会", "能", "的", "了", "呢", "吗", "呀", "啊",
)
DATA_COVERAGE_FOLLOWUP_PATTERN = re.compile(
    r"(?:为什么|为何).*(?:没|没有|不)(?:覆盖|包含|接入|提供|显示).*(?:消息面|新闻|公告|研报|舆情|数据)",
)
MISSING_EVENT_FOLLOWUP_PATTERN = re.compile(
    r"(?:为什么|为何).*(?:没|没有|不).*(?:消息面|新闻|公告|研报|舆情|数据)",
)
ANSWER_FOLLOWUP_PATTERNS = (
    re.compile(r"(?:为什么|为何).*(?:没|没有|不)(?:覆盖|包含|考虑|分析|说明|提到|提供|显示)"),
    re.compile(r"(?:你|刚才|上面|前面|上一条).{0,20}(?:为什么|为何|什么意思|依据|怎么得出|怎么判断)"),
    re.compile(r"(?:这个|该|上述).{0,8}(?:结论|判断|说法|回答).{0,12}(?:为什么|为何|依据|怎么得出|什么意思)"),
)
CONSTITUENT_FOLLOWUP_PATTERN = re.compile(
    r"(?:上涨|下跌|领涨|领跌|涨停|跌停).{0,10}(?:哪些|哪几|都有谁|是谁|几家|几只)"
)
ROLE_CAPABILITY_PATTERN = re.compile(
    r"你是谁|你叫什么|你(?:会|能|可以)(?:做|干|回答|分析)(?:什么|啥|哪些)|"
    r"你(?:能|可以)帮我(?:做|干|分析)?(?:什么|啥|哪些)|"
    r"你擅长(?:做|干)?(?:什么|啥|哪些|哪方面)|你对(?:什么|哪些)领域(?:很)?了解|"
    r"你了解(?:什么|哪些)领域|你的(?:能力|功能|服务范围)(?:是什么|有哪些)?"
)

# --- Tier A：高精度确定信号（权威，始终可信，命中即可确定路由）---
SECTOR_THEMES: Dict[str, Tuple[str, ...]] = {
    "科技": ("半导体", "软件开发", "IT服务Ⅱ", "通信设备", "消费电子"),
    "人工智能": ("软件开发", "计算机设备", "通信设备", "半导体", "消费电子"),
    "AI": ("软件开发", "计算机设备", "通信设备", "半导体", "消费电子"),
    "新能源": ("电池", "光伏设备", "风电设备", "电网设备"),
    "医药": ("化学制药", "生物制品", "医疗器械", "医疗服务", "中药"),
    "金融": ("银行", "证券", "保险及其他"),
}

INDEXES: Dict[str, Dict[str, str]] = {
    "上证指数": {"name": "上证指数", "code": "sh000001", "category": "沪深重要指数"},
    "上证综指": {"name": "上证指数", "code": "sh000001", "category": "沪深重要指数"},
    "沪指": {"name": "上证指数", "code": "sh000001", "category": "沪深重要指数"},
    "上证": {"name": "上证指数", "code": "sh000001", "category": "沪深重要指数"},
    "深证成指": {"name": "深证成指", "code": "sz399001", "category": "沪深重要指数"},
    "深成指": {"name": "深证成指", "code": "sz399001", "category": "沪深重要指数"},
    "创业板指": {"name": "创业板指", "code": "sz399006", "category": "沪深重要指数"},
    "创业板指数": {"name": "创业板指", "code": "sz399006", "category": "沪深重要指数"},
    "创业板": {"name": "创业板指", "code": "sz399006", "category": "沪深重要指数"},
    "科创50": {"name": "科创50", "code": "sh000688", "category": "沪深重要指数"},
    "上证50": {"name": "上证50", "code": "sh000016", "category": "沪深重要指数"},
    "沪深300": {"name": "沪深300", "code": "sh000300", "category": "沪深重要指数"},
    "中证500": {"name": "中证500", "code": "sh000905", "category": "中证系列指数"},
    "中证1000": {"name": "中证1000", "code": "sh000852", "category": "中证系列指数"},
}


def _contains(text: str, values: Tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(value.lower() in lowered for value in values)


def _normalized_route_text(text: str) -> str:
    return re.sub(r"[\s，。！？、,.!?：:；;（）()\[\]【】\"'“”‘’]+", "", text).lower()


def starts_new_topic(text: str) -> bool:
    normalized = re.sub(r"\s+", "", text).lower()
    return any(value.lower() in normalized for value in NEW_TOPIC_WORDS)


def _is_context_only_question(text: str) -> bool:
    normalized = re.sub(r"[\s，。！？、,.!?：:；;（）()]+", "", text).lower()
    for word in sorted(CONTEXT_ONLY_WORDS, key=len, reverse=True):
        normalized = normalized.replace(word.lower(), "")
    return not normalized


def _is_answer_followup(request: ResearchPrepareRequest) -> bool:
    text = re.sub(r"[\s，。！？、,.!?：:；;（）()]+", "", request.text).lower()
    if starts_new_topic(text) or _contains(text, OUT_OF_SCOPE_KEYWORDS):
        return False
    if DATA_COVERAGE_FOLLOWUP_PATTERN.search(text) or MISSING_EVENT_FOLLOWUP_PATTERN.search(text):
        has_security_history = any(
            item.role == "user" and CODE_PATTERN.search(item.content)
            for item in request.history[-20:]
        )
        return not has_security_history
    if not any(item.role == "assistant" and item.content.strip() for item in request.history[-20:]):
        return False
    return any(pattern.search(text) for pattern in ANSWER_FOLLOWUP_PATTERNS)


def _index_target(text: str) -> Optional[Dict[str, str]]:
    normalized = text.replace(" ", "")
    for alias in sorted(INDEXES, key=len, reverse=True):
        if alias.lower() in normalized.lower():
            return INDEXES[alias]
    return None


def _sector_theme(text: str) -> Optional[Tuple[str, Tuple[str, ...]]]:
    normalized = text.replace(" ", "")
    for alias, sectors in SECTOR_THEMES.items():
        if alias in normalized:
            return alias, sectors
    return None


def _intent_for_security(text: str, target_count: int) -> StockIntent:
    if target_count > 1 or _contains(text, COMPARISON_WORDS):
        return "comparison"
    if _contains(text, DECISION_KEYWORDS):
        return "decision"
    if _contains(text, NEWS_KEYWORDS):
        return "security_news"
    if _contains(text, FUNDAMENTAL_KEYWORDS):
        return "fundamental"
    if _contains(text, VALUATION_KEYWORDS):
        return "valuation"
    if _contains(text, RESEARCH_DEPTH_KEYWORDS):
        return "security_trend"
    return "security_quote"


def _intent_for_sector(text: str) -> StockIntent:
    return "sector" if _contains(text, RESEARCH_DEPTH_KEYWORDS) else "sector_snapshot"


def _intent_for_market(text: str) -> StockIntent:
    return "market" if _contains(text, RESEARCH_DEPTH_KEYWORDS) else "market_snapshot"


def _named_target_terms(text: str) -> List[str]:
    return [
        term
        for term in search_terms(text)
        if not _contains(term, ROUTING_NOISE_TERMS)
    ]


def _is_generic_market_query(text: str) -> bool:
    if CODE_PATTERN.search(text) or _index_target(text):
        return False
    if _named_target_terms(text):
        return False
    return _contains(text, MARKET_KEYWORDS + GENERIC_MARKET_KEYWORDS) and (
        _contains(text, SNAPSHOT_KEYWORDS + TREND_KEYWORDS)
        or any(word in text for word in (
            "怎样", "咋样", "情况", "涨吗", "跌吗", "红还是绿", "涨还是跌", "强不强", "好吗", "好不好",
            "还好吗", "咋回事", "怎么了", "整体如何", "热不热", "弱不弱", "有啥变化",
        ))
    )


def _is_sector_scan_query(text: str) -> bool:
    if _contains(text, SECTOR_SCAN_KEYWORDS):
        return True
    if CODE_PATTERN.search(text) or _index_target(text):
        return False
    if _contains(text, ("股票", "个股", "指数")):
        return False
    return (
        _contains(text, GENERIC_SCAN_QUESTIONS)
        and _contains(text, GENERIC_SCAN_TARGETS)
        and _contains(text, GENERIC_SCAN_MOVES)
    )


def _is_stock_screen_query(text: str) -> bool:
    return _contains(text, SCREEN_KEYWORDS)


def _stock_screen_style(text: str) -> str:
    if re.search(r"(?:今天|今日|当日|当前|盘中|收盘).*(?:行情|盘面)|(?:行情|盘面).*(?:推荐|筛选|选股)", text):
        return "momentum"
    matched = {
        style for style, pattern in {
            "quality": r"质量|盈利能力|现金流",
            "growth": r"成长|增速",
            "value": r"估值|低估|价值|市盈率|市净率",
            "momentum": r"动量|趋势|强势",
        }.items() if re.search(pattern, text)
    }
    return next(iter(matched)) if len(matched) == 1 else "balanced"


def _research_plan(intent: StockIntent, text: str, context: Dict[str, Any]) -> List[str]:
    question = " ".join(text.split()).strip()
    if not question:
        return []
    display_question = question if len(question) <= 80 else f"{question[:80]}..."

    if intent == "stock_screen":
        if re.search(r"(?:今天|今日|当日|当前|盘中|收盘).*(?:行情|盘面)", question):
            focus = "先确认最近可用数据时点，再侧重比较候选的趋势动量、回撤和流动性"
        elif _contains(question, ("值得买", "能买吗", "买入", "要不要买")):
            focus = "先区分候选排序与买入决策，再核对估值、质量、趋势、风险和触发条件"
        elif _contains(question, ("推荐", "筛选", "选出", "优质")):
            focus = "先建立合格候选池，再按本次筛选偏好比较质量、成长、估值、动量和风险"
        else:
            focus = "先建立全市场候选池，再验证排序依据、数据缺口和主要风险"
    elif intent == "strategy_backtest":
        focus = "使用前一交易日信号、下一交易日开盘执行，计入成本并核对收益、回撤、夏普和换手率"
    elif intent == "decision":
        focus = "围绕是否可操作，核对支持证据、反证、主要风险、触发条件和失效条件"
    elif intent == "security_news":
        focus = "核对最新新闻与公告的时间、来源和可信度，再判断事件是否影响原有结论"
    elif intent == "security_trend":
        focus = (
            "重点检查波动、回撤、支撑与失效条件"
            if _contains(question, ("风险", "回撤", "止损", "支撑", "压力"))
            else "结合当前快照与历史区间，验证趋势强弱、波动和回撤"
        )
    elif intent == "fundamental":
        focus = "核对最新财报期的收入、利润、现金流、盈利质量和负债变化"
    elif intent == "valuation":
        focus = "把 PE、PB 与增长和盈利质量结合，避免只凭单一估值倍数判断"
    elif intent == "comparison":
        focus = "使用同一数据口径比较标的的基本面、估值、趋势和风险"
    elif intent == "sector_scan":
        focus = "扫描行业广度和趋势，区分严格命中、接近条件与仅供观察的板块"
    elif intent == "sector":
        focus = "结合板块涨跌广度、领涨成分和历史趋势判断强弱及持续性"
    elif intent == "index":
        focus = "结合指数最新点位、区间趋势、波动和回撤判断市场状态"
    elif intent == "market":
        focus = "结合涨跌家数、成交额、市场宽度和领涨方向判断整体环境"
    else:
        focus = "按当前问题选择可验证的数据，并明确事实、计算结果与判断的边界"

    return [
        f"问题理解：{display_question}",
        f"研究计划：{focus}",
    ]


def _requires_research(intent: StockIntent, text: str) -> bool:
    if intent == "index":
        return _contains(text, RESEARCH_DEPTH_KEYWORDS)
    return intent in {
        "security_trend", "security_news", "fundamental", "valuation", "comparison", "stock_screen",
        "decision", "sector", "sector_scan", "market", "strategy_backtest",
    }


def _history_summary(bars: Any) -> Dict[str, Any]:
    rows = [row for row in bars if isinstance(row, dict)] if isinstance(bars, list) else []
    summary: Dict[str, Any] = {"points": len(rows)}
    if rows:
        summary["from"] = rows[0].get("time")
        summary["to"] = rows[-1].get("time")
    return {key: value for key, value in summary.items() if value not in (None, "")}


def compact_research_context(value: Dict[str, Any]) -> Dict[str, Any]:
    def compact(item: Any) -> Any:
        if isinstance(item, dict):
            output = {}
            for key, child in item.items():
                if key == "dailyBars":
                    output["history"] = _history_summary(child)
                elif key == "warnings" and isinstance(child, list):
                    output[key] = [str(warning)[:180] for warning in child[:5]]
                else:
                    output[key] = compact(child)
            return output
        if isinstance(item, list):
            return [compact(child) for child in item[:20]]
        return item

    return compact(value)


def research_context_unavailable(prepared: ResearchPrepareResponse) -> bool:
    context = prepared.context or {}
    if not context or prepared.intent == "education":
        return False
    if context.get("kind") == "security":
        return (context.get("market") or {}).get("status") != "ok"
    if context.get("kind") == "sector_group":
        return not any(
            item.get("status") == "ok"
            for item in context.get("sectors") or []
            if isinstance(item, dict)
        )
    return context.get("status") == "unavailable"


def _number(value: Any, suffix: str = "", digits: int = 2) -> Optional[str]:
    if not isinstance(value, (int, float)):
        return None
    return f"{value:,.{digits}f}{suffix}"


def _market_cap(value: Any) -> Optional[str]:
    if not isinstance(value, (int, float)):
        return None
    return f"{value / 100_000_000:,.0f} 亿元"


def _warning_note(value: Any) -> str:
    text = str(value).replace("\n", " ").strip()
    if "：" in text and "兜底" not in text:
        text = text.split("：", 1)[0]
    return text[:100]


class ResearchService:
    def __init__(self, market: MarketService, quant: Optional["QuantService"] = None):
        self.market = market
        self.quant = quant
        self.tools = ResearchTools(market, quant)

    @staticmethod
    async def _report(progress: Optional[ProgressCallback], text: str) -> None:
        if progress:
            await progress(text)

    @classmethod
    async def _report_records(
        cls,
        progress: Optional[ProgressCallback],
        records: List[str],
    ) -> None:
        for record in records:
            await cls._report(progress, record)

    @staticmethod
    def _reference_query(request: ResearchPrepareRequest) -> str:
        text = request.text.strip()
        if (
            starts_new_topic(text)
            or _contains(text, OUT_OF_SCOPE_KEYWORDS)
        ):
            return request.text
        event_coverage_followup = bool(
            DATA_COVERAGE_FOLLOWUP_PATTERN.search(_normalized_route_text(text))
            or MISSING_EVENT_FOLLOWUP_PATTERN.search(_normalized_route_text(text))
        )
        has_explicit_target = not event_coverage_followup and (
            bool(CODE_PATTERN.search(text))
            or _index_target(text) is not None
            or _sector_theme(text) is not None
            or _contains(text, MARKET_KEYWORDS + GENERIC_MARKET_KEYWORDS)
            or _contains(text, ("股票", "个股", "板块", "行业", "概念", "指数", "a股"))
            or (
                _contains(text, EDUCATION_KEYWORDS)
                and _contains(text, EDUCATION_QUESTION_WORDS)
            )
            or (
                bool(_named_target_terms(text))
                and not _is_context_only_question(text)
                and not CONSTITUENT_FOLLOWUP_PATTERN.search(text)
            )
        )
        if has_explicit_target:
            return request.text
        for item in reversed(request.history[-20:]):
            if item.role != "user":
                continue
            content = item.content.strip()
            if starts_new_topic(content):
                break
            if (
                CODE_PATTERN.search(content)
                or _index_target(content)
                or _named_target_terms(content)
                or _contains(content, ("板块", "行业", "概念", "大盘", "a股", "大a"))
            ):
                return f"{request.text} {content}".strip()
        return request.text

    @staticmethod
    def _out_of_scope(text: str) -> ResearchPrepareResponse:
        return ResearchPrepareResponse(
            scope="out_of_scope",
            intent="out_of_scope",
            requiresResearch=False,
            targetKind="none",
        )

    @staticmethod
    def _clarification(
        reply: str = CLARIFY_MESSAGE,
        options: Optional[List[ClarificationOption]] = None,
        input_placeholder: str = "补充股票、板块、指数或分析条件",
        interactive: bool = True,
    ) -> ResearchPrepareResponse:
        return ResearchPrepareResponse(
            scope="needs_clarification",
            intent="clarification",
            requiresResearch=False,
            targetKind="none",
            reply=reply,
            clarification=(ClarificationCard(
                question=reply,
                options=options or [],
                inputPlaceholder=input_placeholder,
            ) if interactive else None),
        )

    @staticmethod
    def _analysis_records(intent: StockIntent, context: Dict[str, Any], question: str = "") -> List[str]:
        records: List[str] = _research_plan(intent, question, context)
        warnings: List[str] = list(context.get("warnings") or [])
        securities = ((context.get("market") or {}).get("securities") or [])

        if intent in {"security_trend", "security_news", "fundamental", "valuation", "comparison", "decision"}:
            for security in securities:
                name = security.get("name") or security.get("code") or "标的"
                technical = security.get("technical") or {}
                financial = security.get("financial") or {}
                history = security.get("history") or {}
                warnings.extend(security.get("warnings") or [])
                if intent in {"security_news", "decision"}:
                    events = [
                        *list(security.get("announcements") or []),
                        *list(security.get("news") or []),
                    ]
                    events.sort(key=lambda item: item.get("publishedAt") or "", reverse=True)
                    records.append(
                        f"{name}：取得 {len(security.get('news') or [])} 条新闻、"
                        f"{len(security.get('announcements') or [])} 条公告"
                    )
                    for event in events[:5]:
                        records.append(
                            f"[{event.get('sourceId')}] {event.get('publishedAt') or '时间未知'} "
                            f"{event.get('title') or '未命名事件'}（{event.get('verificationStatus') or 'unverified'}）"
                        )
                    if intent == "decision":
                        records.append(
                            f"{name}决策输入：现价 {_number(security.get('price')) or '缺失'}，"
                            f"PE {_number(security.get('peRatio')) or '缺失'}，"
                            f"近20日 {_number(technical.get('return20d'), '%') or '数据不足'}，"
                            f"60日最大回撤 {_number(technical.get('maxDrawdown60d'), '%') or '数据不足'}"
                        )
                elif intent == "security_trend":
                    price = _number(security.get("price"), " 元")
                    change = _number(security.get("changePercent"), "%")
                    snapshot = "，".join([
                        value for value in (
                            f"现价 {price}" if price else None,
                            f"涨跌 {change}" if change else None,
                        ) if value
                    ]) or "行情快照不可用"
                    date = str(security.get("dataTime") or "")[:10]
                    records.append(
                        f"{name}{f'（{date}）' if date else ''}：{snapshot}；"
                        f"历史样本 {history.get('points', 0)} 条"
                    )
                    metrics = [
                        label for label in (
                            f"近20日 {_number(technical.get('return20d'), '%')}" if _number(technical.get("return20d"), "%") else None,
                            f"MA20 {_number(technical.get('ma20'))}" if _number(technical.get("ma20")) else None,
                            f"年化波动 {_number(technical.get('volatility20d'), '%')}" if _number(technical.get("volatility20d"), "%") else None,
                            f"60日最大回撤 {_number(technical.get('maxDrawdown60d'), '%')}" if _number(technical.get("maxDrawdown60d"), "%") else None,
                        ) if label
                    ]
                    records.append(f"{name}：{'，'.join(metrics)}" if metrics else f"{name}缺少足够历史数据，未生成趋势指标")
                elif intent == "fundamental":
                    report = financial.get("reportDate") or "最近一期"
                    metrics = [
                        label for label in (
                            f"营收同比 {_number(financial.get('revenueYoY'), '%')}" if _number(financial.get("revenueYoY"), "%") else None,
                            f"归母净利润同比 {_number(financial.get('netProfitYoY'), '%')}" if _number(financial.get("netProfitYoY"), "%") else None,
                            f"ROE {_number(financial.get('roe'), '%')}" if _number(financial.get("roe"), "%") else None,
                            f"资产负债率 {_number(financial.get('debtRatio'), '%')}" if _number(financial.get("debtRatio"), "%") else None,
                            f"每股经营现金流 {_number(financial.get('operatingCashFlowPerShare'))}" if _number(financial.get("operatingCashFlowPerShare")) else None,
                        ) if label
                    ]
                    records.append(f"{name} {report}：{'，'.join(metrics)}" if metrics else f"{name}未取得可用财务指标")
                elif intent == "valuation":
                    metrics = [
                        label for label in (
                            f"PE {_number(security.get('peRatio'))}" if _number(security.get("peRatio")) else None,
                            f"PB {_number(security.get('pbRatio'))}" if _number(security.get("pbRatio")) else None,
                            f"总市值 {_market_cap(security.get('marketCap'))}" if _market_cap(security.get("marketCap")) else None,
                            f"利润同比 {_number(financial.get('netProfitYoY'), '%')}" if _number(financial.get("netProfitYoY"), "%") else None,
                            f"近20日 {_number(technical.get('return20d'), '%')}" if _number(technical.get("return20d"), "%") else None,
                        ) if label
                    ]
                    records.append(f"{name}当前估值口径：{'，'.join(metrics)}" if metrics else f"{name}缺少可用估值数据")
                else:
                    metrics = [
                        label for label in (
                            f"现价 {_number(security.get('price'))}" if _number(security.get("price")) else None,
                            f"近20日 {_number(technical.get('return20d'), '%')}" if _number(technical.get("return20d"), "%") else None,
                            f"PE {_number(security.get('peRatio'))}" if _number(security.get("peRatio")) else None,
                            f"ROE {_number(financial.get('roe'), '%')}" if _number(financial.get("roe"), "%") else None,
                        ) if label
                    ]
                    records.append(f"{name}：{'，'.join(metrics)}" if metrics else f"{name}缺少可比较指标")
        elif intent == "stock_screen":
            criteria = context.get("criteria") or {}
            style_note = {
                "balanced": "本次采用综合均衡策略，综合考虑质量、成长、估值、动量和风险",
                "quality": "本次采用质量优先策略，重点考虑盈利质量与风险",
                "growth": "本次采用成长优先策略，重点考虑营收和利润增速",
                "value": "本次采用估值优先策略，重点考虑 PE、PB 与基本面质量",
                "momentum": "本次采用趋势动量策略，重点考虑近期走势与回撤风险",
            }.get(str(context.get("style") or "balanced"))
            if style_note:
                records.append(style_note)
            if context.get("engine") == "multi_factor":
                records.append(
                    f"第二阶段多因子引擎已生效：使用本地 DuckDB 的 {context.get('asOf') or '最近'} 数据截面，"
                    f"因子版本 {context.get('factorVersion') or '未知'}"
                )
                records.append(
                    f"全市场因子计算后共有 {context.get('universeCount', 0)} 只股票达到覆盖率门槛；"
                    f"Point-in-time={bool(criteria.get('pointInTime'))}，行业中性化={bool(criteria.get('industryNeutralized'))}"
                )
            else:
                records.append(
                    f"当前使用实时快照降级链路：全市场 {criteria.get('universeCount', 0)} 只股票中，"
                    f"{criteria.get('eligibleCount', 0)} 只通过基础条件，"
                    f"{criteria.get('enrichedCount', 0)} 只完成财务与趋势评分"
                )
            for stock in (context.get("stocks") or [])[:5]:
                breakdown = stock.get("scoreBreakdown") or {}
                coverage = _number((stock.get("coverage") or 0) * 100, "%") if stock.get("coverage") is not None else None
                coverage_note = (
                    f"，覆盖率 {coverage}，置信度 {stock.get('confidence')}"
                    if coverage else ""
                )
                records.append(
                    f"#{stock.get('rank', '-')} {stock.get('name') or stock.get('code')}："
                    f"系统评分 {_number(stock.get('score')) or '缺失'}，"
                    f"质量 {_number(breakdown.get('quality')) or '缺失'}，"
                    f"成长 {_number(breakdown.get('growth')) or '缺失'}，"
                    f"估值 {_number(breakdown.get('value')) or '缺失'}，"
                    f"动量 {_number(breakdown.get('momentum')) or '缺失'}"
                    f"{coverage_note}"
                )
        elif intent == "strategy_backtest":
            result = context.get("result") or {}
            parameters = context.get("parameters") or {}
            records.append(
                f"回测区间 {context.get('startDate') or '未知'} 至 {context.get('endDate') or '未知'}，"
                f"因子版本 {context.get('factorVersion') or '未知'}"
            )
            records.append(
                f"执行口径：{parameters.get('signalTiming') or '未提供'}；"
                f"调仓 {result.get('rebalanceCount', 0)} 次，平均换手率 {_number(result.get('averageTurnover'), '%') or '缺失'}"
            )
            records.append(
                f"策略总收益 {_number(result.get('totalReturn'), '%') or '缺失'}，"
                f"基准收益 {_number(result.get('benchmarkReturn'), '%') or '缺失'}，"
                f"最大回撤 {_number(result.get('maxDrawdown'), '%') or '缺失'}，"
                f"夏普比率 {_number(result.get('sharpe')) or '缺失'}"
            )
        elif intent == "sector_scan":
            criteria = context.get("criteria") or {}
            sectors = context.get("sectors") or []
            records.append(
                f"扫描 {criteria.get('universeCount', 0)} 个行业，"
                f"对 {criteria.get('scannedCount', 0)} 个候选完成了 {criteria.get('windowDays', 60)} 日趋势计算"
            )
            for sector in sectors[:5]:
                technical = sector.get("technical") or {}
                snapshot = sector.get("snapshot") or {}
                level = {"strict": "符合严格条件", "near": "接近条件", "watch": "观察项"}.get(
                    sector.get("matchLevel"),
                    "观察项",
                )
                records.append(
                    f"#{sector.get('rank', '-')} {sector.get('name', '板块')}（{level}）："
                    f"近20日 {_number(technical.get('return20d'), '%') or '数据不足'}，"
                    f"近60日 {_number(technical.get('return60d'), '%') or '数据不足'}，"
                    f"最大回撤 {_number(technical.get('maxDrawdown60d'), '%') or '数据不足'}，"
                    f"当日 {snapshot.get('advancers', 0)} 家上涨/{snapshot.get('decliners', 0)} 家下跌"
                )
            if not sectors:
                records.append("本次没有取得可用于排名的行业历史数据")
        elif intent == "sector":
            if context.get("kind") == "sector_group":
                for sector_context in context.get("sectors") or []:
                    records.extend(ResearchService._analysis_records("sector", sector_context))
            else:
                name = context.get("name") or "板块"
                snapshot = context.get("snapshot") or {}
                breadth = context.get("breadth") or {}
                technical = context.get("technical") or {}
                records.append(
                    f"{name}板块：涨跌 {_number(snapshot.get('changePercent'), '%') or '暂无'}，"
                    f"{breadth.get('advancers', 0)} 家上涨、{breadth.get('decliners', 0)} 家下跌"
                )
                leaders = context.get("leaders") or []
                leader = leaders[0] if leaders else {}
                leader_change = _number(leader.get("changePercent"), "%")
                records.append(
                    f"近20日 {_number(technical.get('return20d'), '%') or '数据不足'}；"
                    f"领涨股 {leader.get('name') or '暂无'}"
                    f"{'（' + leader_change + '）' if leader_change else ''}"
                )
        elif intent == "index":
            name = context.get("name") or "指数"
            snapshot = context.get("snapshot") or {}
            technical = context.get("technical") or {}
            records.append(
                f"{name}：点位 {_number(snapshot.get('price')) or '暂无'}，涨跌 {_number(snapshot.get('changePercent'), '%') or '暂无'}"
            )
            records.append(
                f"近20日 {_number(technical.get('return20d'), '%') or '数据不足'}，"
                f"20日波动 {_number(technical.get('volatility20d'), '%') or '数据不足'}，"
                f"60日最大回撤 {_number(technical.get('maxDrawdown60d'), '%') or '数据不足'}"
            )
        elif intent == "market":
            indices = context.get("indices") or []
            if isinstance(context.get("advancers"), (int, float)):
                records.append(
                    f"全市场：{context.get('advancers', 0)} 家上涨、{context.get('decliners', 0)} 家下跌，"
                    f"中位涨跌 {_number(context.get('medianChangePercent'), '%') or '暂无'}"
                )
            elif indices:
                records.append("主要指数：" + "，".join(
                    f"{item.get('name') or item.get('code')} {_number(item.get('changePercent'), '%') or '暂无'}"
                    for item in indices[:4]
                ))
            details = []
            if _market_cap(context.get("totalAmount")):
                details.append(f"两市成交额 {_market_cap(context.get('totalAmount'))}")
            leaders = "、".join(item.get("name", "") for item in (context.get("leaders") or [])[:3])
            if leaders:
                details.append(f"领涨 {leaders}")
            if details:
                records.append("；".join(details))

        for warning in list(dict.fromkeys(_warning_note(item) for item in warnings if item))[:3]:
            records.append(f"数据说明：{warning}")
        return [record for record in records if record]

    async def _security_response(
        self,
        text: str,
        market_context,
        progress: Optional[ProgressCallback] = None,
        intent_override: Optional[StockIntent] = None,
    ) -> ResearchPrepareResponse:
        targets = [
            ResearchTarget(kind="security", name=item.name, code=item.code)
            for item in market_context.securities
        ]
        intent = intent_override or _intent_for_security(text, len(targets))
        requires = _requires_research(intent, text)
        context = compact_research_context({
            "kind": "security",
            "market": market_context.model_dump(exclude_none=True),
        })
        warnings = [warning for item in market_context.securities for warning in item.warnings]
        if warnings:
            context["warnings"] = warnings
        thoughts = self._analysis_records(intent, context, text) if requires else []
        await self._report_records(progress, thoughts)
        return ResearchPrepareResponse(
            scope="in_scope",
            intent=intent,
            requiresResearch=requires,
            targetKind="security",
            targets=targets,
            thoughts=thoughts,
            skills=skills_for_intent(intent, requires),
            context=context,
        )

    async def _market_response(
        self,
        text: str,
        progress: Optional[ProgressCallback] = None,
        intent_override: Optional[StockIntent] = None,
    ) -> ResearchPrepareResponse:
        intent = intent_override or _intent_for_market(text)
        requires = _requires_research(intent, text)
        if requires:
            await self._report(progress, "正在获取全市场涨跌、成交额和市场宽度数据")
        context = compact_research_context(await self.market.market_overview())
        thoughts = self._analysis_records("market", context, text) if requires else []
        await self._report_records(progress, thoughts)
        return ResearchPrepareResponse(
            scope="in_scope",
            intent=intent,
            requiresResearch=requires,
            targetKind="market",
            targets=[ResearchTarget(kind="market", name="A 股市场")],
            thoughts=thoughts,
            skills=skills_for_intent(intent, requires),
            context=context,
        )

    async def _sector_response(
        self,
        text: str,
        sector: Dict[str, str],
        progress: Optional[ProgressCallback] = None,
        intent_override: Optional[StockIntent] = None,
    ) -> ResearchPrepareResponse:
        intent = intent_override or _intent_for_sector(text)
        requires = _requires_research(intent, text)
        if requires:
            await self._report(progress, f"正在获取{sector['name']}板块的行情、成分股和历史数据")
        context = compact_research_context(
            await self.market.sector_context(sector["kind"], sector["code"], sector["name"]),
        )
        thoughts = self._analysis_records("sector", context, text) if requires else []
        await self._report_records(progress, thoughts)
        return ResearchPrepareResponse(
            scope="in_scope",
            intent=intent,
            requiresResearch=requires,
            targetKind="sector",
            targets=[ResearchTarget(kind="sector", name=sector["name"], code=sector["code"])],
            thoughts=thoughts,
            skills=skills_for_intent(intent, requires),
            context=context,
        )

    async def prepare(
        self,
        request: ResearchPrepareRequest,
        progress: Optional[ProgressCallback] = None,
    ) -> ResearchPrepareResponse:
        if request.roleId != "stock_expert":
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="education",
                requiresResearch=False,
                targetKind="knowledge",
            )

        text = request.text.strip()
        route = request.routeHint if request.routeHint and request.routeHint.confidence >= ROUTE_HINT_CONFIDENCE else None
        if route is None and ROLE_CAPABILITY_PATTERN.search(text):
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="role_capability",
                requiresResearch=False,
                targetKind="knowledge",
                targets=[ResearchTarget(kind="knowledge", name="角色能力")],
            )
        reference_query = self._reference_query(request)
        contextual_constituent_followup = bool(
            CONSTITUENT_FOLLOWUP_PATTERN.search(text)
            and reference_query != text
        )
        if contextual_constituent_followup:
            route = None
        strong_target = (
            bool(CODE_PATTERN.search(text))
            or _index_target(text) is not None
            or _sector_theme(text) is not None
            or _is_stock_screen_query(text)
        )
        route_terms: List[str] = []
        if route:
            route_material = [text] if route.relation == "new_topic" else [
                text,
                *(item.content for item in request.history[-20:]),
            ]
            material = _normalized_route_text("\n".join(route_material))
            route_terms = [
                term for term in route.targetTerms
                if _normalized_route_text(term) and _normalized_route_text(term) in material
            ][:3]
            if (
                route.scope == "in_scope"
                and (route.intent == "answer_followup" or route.relation == "answer_explanation")
                and not (
                    DATA_COVERAGE_FOLLOWUP_PATTERN.search(_normalized_route_text(text))
                    or MISSING_EVENT_FOLLOWUP_PATTERN.search(_normalized_route_text(text))
                )
            ):
                return ResearchPrepareResponse(
                    scope="in_scope",
                    intent="answer_followup",
                    requiresResearch=False,
                    targetKind="knowledge",
                    targets=[ResearchTarget(kind="knowledge", name="上一条回答")],
                )
            if (
                route.scope == "in_scope"
                and route.intent == "role_capability"
            ):
                return ResearchPrepareResponse(
                    scope="in_scope",
                    intent="role_capability",
                    requiresResearch=False,
                    targetKind="knowledge",
                    targets=[ResearchTarget(kind="knowledge", name="角色能力")],
                )
            if not strong_target and route.scope == "out_of_scope":
                return self._out_of_scope(text)
            if not strong_target and route.scope == "needs_clarification":
                return self._clarification()
            if (
                route.scope == "in_scope"
                and route.intent == "education"
            ):
                return ResearchPrepareResponse(
                    scope="in_scope",
                    intent="education",
                    requiresResearch=False,
                    targetKind="knowledge",
                    targets=[ResearchTarget(kind="knowledge", name="股票知识")],
                )
        if route_terms:
            reference_query = (
                " ".join(route_terms)
                if route and route.targetKind == "security"
                else f"{text} {' '.join(route_terms)}".strip()
            )
        route_intent = route.intent if route and route.scope == "in_scope" else None
        has_explicit_stock_signal = bool(CODE_PATTERN.search(reference_query)) or _contains(
            reference_query,
            EDUCATION_KEYWORDS + MARKET_KEYWORDS + GENERIC_MARKET_KEYWORDS
            + NEWS_KEYWORDS + DECISION_KEYWORDS + SCREEN_KEYWORDS
            + ("股票", "个股", "板块", "行业", "概念", "指数", "a股"),
        ) or _index_target(reference_query) is not None
        has_stock_signal = bool(CODE_PATTERN.search(reference_query)) or _contains(
            reference_query,
            EDUCATION_KEYWORDS + MARKET_KEYWORDS + GENERIC_MARKET_KEYWORDS
            + TREND_KEYWORDS + QUOTE_KEYWORDS + NEWS_KEYWORDS + DECISION_KEYWORDS + SCREEN_KEYWORDS
            + ("股票", "个股", "板块", "行业", "概念", "指数", "a股"),
        ) or _index_target(reference_query) is not None
        if route is None and _contains(text, OUT_OF_SCOPE_KEYWORDS) and not has_explicit_stock_signal:
            return self._out_of_scope(text)

        if _is_answer_followup(request):
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="answer_followup",
                requiresResearch=False,
                targetKind="knowledge",
                targets=[ResearchTarget(kind="knowledge", name="上一条回答")],
            )

        if route_intent == "strategy_backtest":
            style = route.factorStyle if route and route.factorStyle else _stock_screen_style(text)
            if self.quant is None:
                context = {
                    "kind": "strategy_backtest",
                    "status": "unavailable",
                    "error": "量化服务未配置",
                }
            else:
                status_result = await self.quant.status()
                end_text = status_result.get("price_to")
                start_floor = status_result.get("price_from")
                if not end_text:
                    context = {
                        "kind": "strategy_backtest",
                        "status": "unavailable",
                        "error": "本地量化仓库还没有历史行情",
                    }
                else:
                    end_date = date.fromisoformat(str(end_text))
                    requested_days = route.timeRangeDays if route and route.timeRangeDays else 365
                    start_date = end_date - timedelta(days=requested_days)
                    if start_floor:
                        start_date = max(start_date, date.fromisoformat(str(start_floor)))
                    await self._report(
                        progress,
                        f"正在使用本地 DuckDB 回测 {start_date.isoformat()} 至 {end_date.isoformat()} 的多因子策略",
                    )
                    context = compact_research_context(await self.tools.call("run_strategy_backtest", {
                        "style": style,
                        "startDate": start_date.isoformat(),
                        "endDate": end_date.isoformat(),
                        "topN": 20,
                        "rebalanceDays": 20,
                    }))
            thoughts = self._analysis_records("strategy_backtest", context, text)
            await self._report_records(progress, thoughts)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="strategy_backtest",
                requiresResearch=True,
                targetKind="market",
                targets=[ResearchTarget(kind="market", name="A 股多因子策略")],
                thoughts=thoughts,
                skills=skills_for_intent("strategy_backtest", True),
                context=context,
            )

        if route_intent == "stock_screen" or _is_stock_screen_query(reference_query):
            style = route.factorStyle if route and route.factorStyle else _stock_screen_style(text)
            style_label = {
                "balanced": "综合均衡", "quality": "质量优先", "growth": "成长优先",
                "value": "估值优先", "momentum": "趋势动量",
            }[style]
            await self._report(progress, f"正在按{style_label}策略优先调用本地多因子引擎进行全市场筛选")
            context = compact_research_context(
                await self.market.screen_stocks(style=style, limit=5, progress=progress),
            )
            targets = [
                ResearchTarget(kind="security", name=item.get("name") or "候选股票", code=item.get("code"))
                for item in (context.get("stocks") or [])[:5]
            ]
            thoughts = self._analysis_records("stock_screen", context, text)
            await self._report_records(progress, thoughts)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="stock_screen",
                requiresResearch=True,
                targetKind="market",
                targets=targets,
                thoughts=thoughts,
                skills=skills_for_intent("stock_screen", True),
                context=context,
            )

        index = _index_target(reference_query)
        if index:
            intent: StockIntent = "index"
            requires = _requires_research(intent, text)
            if requires:
                await self._report(progress, f"正在获取{index['name']}的行情和历史数据")
            context = compact_research_context(
                await self.market.index_context(index["code"], index["name"], index["category"]),
            )
            targets = [ResearchTarget(kind="index", name=index["name"], code=index["code"])]
            thoughts = self._analysis_records(intent, context, text) if requires else []
            await self._report_records(progress, thoughts)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent=intent,
                requiresResearch=requires,
                targetKind="index",
                targets=targets,
                thoughts=thoughts,
                skills=skills_for_intent(intent, requires),
                context=context,
            )

        if (
            _contains(text, EDUCATION_KEYWORDS)
            and _contains(text, EDUCATION_QUESTION_WORDS)
            and not CODE_PATTERN.search(reference_query)
        ):
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="education",
                requiresResearch=False,
                targetKind="knowledge",
                targets=[ResearchTarget(kind="knowledge", name="股票知识")],
            )

        if route_intent == "sector_scan" or (
            _is_sector_scan_query(reference_query)
            and not contextual_constituent_followup
        ):
            window_days = 20 if route and route.timeRangeDays and route.timeRangeDays <= 30 else 60
            await self._report(progress, "正在读取全市场行业快照")
            context = compact_research_context(
                await self.tools.scan_sectors(limit=5, window_days=window_days, progress=progress),
            )
            targets = [
                ResearchTarget(kind="sector", name=item.get("name") or "行业板块", code=item.get("code"))
                for item in (context.get("sectors") or [])[:5]
            ]
            thoughts = self._analysis_records("sector_scan", context, text)
            await self._report_records(progress, [*thoughts[:2], *thoughts[3:]])
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="sector_scan",
                requiresResearch=True,
                targetKind="sector",
                targets=targets,
                thoughts=thoughts,
                skills=skills_for_intent("sector_scan", True),
                context=context,
            )

        theme = _sector_theme(reference_query)
        if theme:
            theme_name, sector_names = theme
            await self._report(
                progress,
                f"正在把{theme_name}主题拆分为可查询的标准行业",
            )
            sectors = await self.market.resolve_sector_names(list(sector_names))
            if not sectors:
                return self._clarification(
                    f"暂时无法取得{theme_name}主题的行业分类数据，请稍后重试。",
                    interactive=False,
                )
            await self._report(
                progress,
                f"已识别 {'、'.join(item['name'] for item in sectors)}，开始获取行情和历史趋势",
            )
            tasks = [asyncio.create_task(self.market.sector_context(
                item["kind"],
                item["code"],
                item["name"],
            )) for item in sectors]
            sector_contexts = []
            for task in asyncio.as_completed(tasks):
                sector_context = compact_research_context(await task)
                sector_contexts.append(sector_context)
                await self._report_records(
                    progress,
                    self._analysis_records("sector", sector_context),
                )
            sector_contexts.sort(
                key=lambda item: (item.get("technical") or {}).get("return20d")
                if (item.get("technical") or {}).get("return20d") is not None else float("-inf"),
                reverse=True,
            )
            context = {
                "kind": "sector_group",
                "status": "ok" if sector_contexts else "unavailable",
                "name": theme_name,
                "sectors": sector_contexts,
            }
            thoughts = self._analysis_records("sector", context, text)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="sector",
                requiresResearch=True,
                targetKind="sector",
                targets=[
                    ResearchTarget(kind="sector", name=item["name"], code=item["code"])
                    for item in sectors
                ],
                thoughts=thoughts,
                skills=skills_for_intent("sector", True),
                context=context,
            )

        if (route and route.targetKind == "market") or _is_generic_market_query(reference_query):
            market_intent = route_intent if route_intent in {"market", "market_snapshot"} else None
            return await self._market_response(text, progress, market_intent)

        sector = None
        sector_candidates: List[Dict[str, str]] = []
        if not CODE_PATTERN.search(reference_query):
            sector, sector_candidates = await self.market.resolve_sector(reference_query)
        if sector_candidates:
            names = "、".join(item["name"] for item in sector_candidates)
            return self._clarification(
                f"找到多个可能的板块：{names}。请选择要分析的板块。",
                [
                    ClarificationOption(
                        id=item["code"],
                        label=item["name"],
                        value=item["name"],
                        description=item["code"],
                    )
                    for item in sector_candidates[:6]
                ],
                "输入更准确的板块名称",
            )
        if sector:
            sector_intent = route_intent if route_intent in {"sector", "sector_snapshot"} else None
            return await self._sector_response(text, sector, progress, sector_intent)

        explicit_sector = _contains(reference_query, ("板块", "行业", "概念"))
        if not CODE_PATTERN.search(reference_query) and not explicit_sector:
            securities, candidates, _ = await self.market.resolve_securities(reference_query)
            if candidates:
                choices = "、".join(f"{item['name']}（{item['code']}）" for item in candidates)
                return self._clarification(
                    f"找到多个可能的股票：{choices}。请选择要分析的股票。",
                    [
                        ClarificationOption(
                            id=item["code"],
                            label=item["name"],
                            value=item["code"].split(".")[-1],
                            description=item["code"],
                        )
                        for item in candidates[:6]
                    ],
                    "输入股票名称或六位代码",
                )
            if securities:
                intent = route_intent if route_intent in {
                    "security_quote", "security_trend", "security_news", "fundamental", "valuation",
                    "comparison", "decision",
                } else _intent_for_security(text, len(securities))
                if _requires_research(intent, text):
                    names = "、".join(item["name"] for item in securities)
                    await self._report(progress, f"正在获取{names}的行情、财务和历史数据")
                include_events = intent in {"security_trend", "security_news", "fundamental", "decision"}
                resolved_query = " ".join(item["code"].split(".")[-1] for item in securities)
                market_context = await self.market.context(resolved_query, 120, True) if include_events else (
                    await self.market.context(resolved_query, 120)
                )
                if market_context.status in {"ok", "unavailable"}:
                    return await self._security_response(text, market_context, progress, intent)

        target_count = max(1, len(CODE_PATTERN.findall(reference_query)))
        likely_intent = route_intent if route_intent in {
            "security_quote", "security_trend", "security_news", "fundamental", "valuation",
            "comparison", "decision",
        } else _intent_for_security(text, target_count)
        if CODE_PATTERN.search(reference_query) and _requires_research(likely_intent, text):
            await self._report(progress, "正在解析标的并获取行情、财务和历史数据")
        include_events = likely_intent in {"security_trend", "security_news", "fundamental", "decision"}
        market_context = await self.market.context(reference_query, 120, True) if include_events else (
            await self.market.context(reference_query, 120)
        )
        if market_context.status == "ambiguous":
            choices = "、".join(f"{item.name}（{item.code}）" for item in market_context.candidates)
            return self._clarification(
                f"找到多个可能的股票：{choices}。请选择要分析的股票。",
                [
                    ClarificationOption(
                        id=item.code,
                        label=item.name,
                        value=item.code.split(".")[-1],
                        description=item.code,
                    )
                    for item in market_context.candidates[:6]
                ],
                "输入股票名称或六位代码",
            )
        if market_context.status in {"ok", "unavailable"}:
            return await self._security_response(text, market_context, progress, likely_intent)

        if has_stock_signal or route and route.scope == "in_scope":
            return self._clarification()
        return self._out_of_scope(text)
