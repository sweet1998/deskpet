from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


RoleId = Literal["default", "stock_expert"]
StockIntent = Literal[
    "security_quote",
    "security_trend",
    "fundamental",
    "valuation",
    "comparison",
    "sector",
    "index",
    "market",
    "education",
    "clarification",
    "out_of_scope",
]


class MarketContextRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    fields: List[Literal[
        "snapshot",
        "valuation",
        "daily_kline",
        "company_profile",
        "financial",
        "technical",
    ]] = Field(
        default_factory=lambda: [
            "snapshot",
            "valuation",
            "daily_kline",
            "company_profile",
            "financial",
            "technical",
        ],
        max_length=6,
    )
    dailyCount: int = Field(default=120, ge=1, le=120)


class MarketCandidate(BaseModel):
    code: str
    name: str
    market: str


class DailyBar(BaseModel):
    time: str
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: Optional[float] = None
    volume: Optional[float] = None


class CompanyProfile(BaseModel):
    industry: Optional[str] = None
    listingDate: Optional[str] = None
    totalShares: Optional[float] = None
    floatShares: Optional[float] = None
    floatMarketCap: Optional[float] = None


class FinancialSnapshot(BaseModel):
    reportDate: Optional[str] = None
    eps: Optional[float] = None
    revenue: Optional[float] = None
    revenueYoY: Optional[float] = None
    netProfit: Optional[float] = None
    netProfitYoY: Optional[float] = None
    roe: Optional[float] = None
    grossMargin: Optional[float] = None
    netMargin: Optional[float] = None
    debtRatio: Optional[float] = None
    operatingCashFlowPerShare: Optional[float] = None


class TechnicalSummary(BaseModel):
    return5d: Optional[float] = None
    return20d: Optional[float] = None
    return60d: Optional[float] = None
    ma5: Optional[float] = None
    ma20: Optional[float] = None
    ma60: Optional[float] = None
    volatility20d: Optional[float] = None
    maxDrawdown60d: Optional[float] = None


class SecurityContext(MarketCandidate):
    price: Optional[float] = None
    changePercent: Optional[float] = None
    dataTime: str = ""
    marketStatus: Literal["trading", "closed", "unknown"] = "unknown"
    stale: bool = False
    peRatio: Optional[float] = None
    pbRatio: Optional[float] = None
    marketCap: Optional[float] = None
    dailyBars: List[DailyBar] = Field(default_factory=list)
    profile: CompanyProfile = Field(default_factory=CompanyProfile)
    financial: FinancialSnapshot = Field(default_factory=FinancialSnapshot)
    technical: TechnicalSummary = Field(default_factory=TechnicalSummary)
    dataSources: Dict[str, str] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)


class MarketContextResponse(BaseModel):
    status: Literal["ok", "ambiguous", "unavailable", "no-symbol"]
    source: str
    asOf: Optional[str] = None
    marketStatus: Optional[str] = None
    securities: List[SecurityContext] = Field(default_factory=list)
    candidates: List[MarketCandidate] = Field(default_factory=list)
    error: Optional[str] = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=12000)


class ResearchTarget(BaseModel):
    kind: Literal["security", "sector", "index", "market", "knowledge"]
    name: str
    code: Optional[str] = None


class ResearchPrepareRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    roleId: RoleId = "stock_expert"
    history: List[ChatMessage] = Field(default_factory=list, max_length=6)


class ResearchPrepareResponse(BaseModel):
    scope: Literal["in_scope", "needs_clarification", "out_of_scope"]
    intent: StockIntent
    requiresResearch: bool = False
    targetKind: Literal["security", "sector", "index", "market", "knowledge", "none"] = "none"
    targets: List[ResearchTarget] = Field(default_factory=list)
    thoughts: List[str] = Field(default_factory=list)
    context: Optional[Dict[str, Any]] = None
    reply: Optional[str] = None


class AgentChatRequest(BaseModel):
    requestId: str = Field(min_length=1, max_length=100)
    roleId: RoleId = "default"
    text: str = Field(min_length=1, max_length=4000)
    conversationId: Optional[str] = Field(default=None, max_length=100)
    userId: Optional[str] = Field(default=None, max_length=100)
    userName: Optional[str] = Field(default=None, max_length=80)
    memories: List[str] = Field(default_factory=list, max_length=30)
    history: List[ChatMessage] = Field(default_factory=list, max_length=20)

    @field_validator("memories")
    @classmethod
    def validate_memories(cls, values: List[str]) -> List[str]:
        return [value.strip()[:500] for value in values if value.strip()]


class RoleProfile(BaseModel):
    roleId: RoleId
    name: str
    systemPrompt: str
    responseStyle: str
    riskNotice: str = ""
    capabilities: List[str] = Field(default_factory=list)
    outOfScopeMessage: str = ""


class SSEEvent(BaseModel):
    event: str
    data: Dict[str, Any]


class MemoryInput(BaseModel):
    content: str = Field(min_length=1, max_length=500)


class MemoryRecord(BaseModel):
    id: str
    content: str
