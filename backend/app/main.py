import asyncio
from contextlib import asynccontextmanager, suppress
from typing import Any, AsyncIterator, Dict, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .agent.model_client import OpenAICompatibleModel
from .agent.service import AgentService
from .cache import TTLCache
from .config import settings
from .market.providers import (
    AkshareProvider,
    CninfoProvider,
    EastmoneyProvider,
    SinaProvider,
    TencentProvider,
    TushareProvider,
)
from .market.service import MarketService
from .mcp import handle_mcp_request
from .memory import MemoryRepository
from .models import (
    AgentChatRequest,
    FactorComparisonRequest,
    FactorScreenRequest,
    MarketContextRequest,
    MarketContextResponse,
    MemoryInput,
    MemoryRecord,
    QuantRefreshRequest,
    ResearchPrepareRequest,
    ResearchPrepareResponse,
    SectorScanRequest,
    StockScreenRequest,
    StrategyBacktestRequest,
)
from .quant.repository import QuantRepository
from .quant.service import QuantService
from .rate_limit import SlidingWindowRateLimiter


def create_services():
    provider_types = {
        "akshare": AkshareProvider,
        "tencent": TencentProvider,
        "eastmoney": EastmoneyProvider,
    }
    provider_type = provider_types.get(settings.market_provider)
    if not provider_type:
        raise RuntimeError(f"暂不支持行情供应商：{settings.market_provider}")
    fallback_type = provider_types.get(settings.market_fallback_provider or "")
    if settings.market_fallback_provider and not fallback_type:
        raise RuntimeError(f"暂不支持兜底行情供应商：{settings.market_fallback_provider}")
    cache = TTLCache(settings.redis_url, settings.market_cache_path)
    provider = provider_type(timeout=settings.market_request_timeout)
    fallback = (
        fallback_type(timeout=settings.market_request_timeout)
        if fallback_type and fallback_type is not provider_type
        else None
    )
    universe_fallback = SinaProvider(timeout=max(30, settings.market_request_timeout))
    professional = None
    if settings.professional_data_provider == "tushare":
        professional = TushareProvider(
            token=settings.tushare_token,
            timeout=max(15, settings.market_request_timeout),
            financial_enabled=settings.tushare_financial_enabled,
        )
    elif settings.professional_data_provider:
        raise RuntimeError(f"暂不支持专业数据供应商：{settings.professional_data_provider}")
    announcement_provider = None
    if settings.official_announcement_provider == "cninfo":
        announcement_provider = CninfoProvider(timeout=max(15, settings.market_request_timeout))
    elif settings.official_announcement_provider:
        raise RuntimeError(f"暂不支持公告供应商：{settings.official_announcement_provider}")
    quant = None
    if isinstance(professional, TushareProvider) and settings.quant_db_path:
        quant = QuantService(QuantRepository(settings.quant_db_path), professional)
    market = MarketService(
        provider,
        cache,
        fallback,
        universe_fallback,
        professional,
        announcement_provider,
        quant,
    )
    if quant is not None:
        quant.instrument_fallback = market.quant_instrument_fallback
    model = OpenAICompatibleModel(
        base_url=settings.model_base_url,
        api_key=settings.model_api_key,
        model=settings.model_name,
        timeout=settings.model_timeout,
    )
    intent_model = OpenAICompatibleModel(
        base_url=settings.router_model_base_url,
        api_key=settings.router_model_api_key,
        model=settings.router_model_name,
        timeout=settings.router_model_timeout,
        route_extra_body={"enable_thinking": False},
    )
    return market, quant, AgentService(market, model, intent_model, quant)


async def maintain_sector_scan_cache(market: MarketService) -> None:
    await asyncio.sleep(3)
    while True:
        try:
            await market.scan_sectors(limit=10, window_days=60)
        except Exception:
            pass
        await asyncio.sleep(900)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    market, quant, agent = create_services()
    app.state.market = market
    app.state.quant = quant
    app.state.agent = agent
    if quant is not None:
        await quant.start()
    app.state.memories = MemoryRepository(settings.database_url)
    await app.state.memories.start()
    app.state.rate_limiter = SlidingWindowRateLimiter(settings.rate_limit_per_minute)
    sector_scan_task = asyncio.create_task(maintain_sector_scan_cache(market))
    yield
    sector_scan_task.cancel()
    with suppress(asyncio.CancelledError):
        await sector_scan_task
    await agent.close()
    await market.close()
    await app.state.memories.close()


app = FastAPI(
    title="麦麦 AI 桌宠后端",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Device-Id"],
)


async def authorize(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_device_id: Optional[str] = Header(default=None),
) -> str:
    if settings.api_token:
        expected = f"Bearer {settings.api_token}"
        if authorization != expected:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效的访问令牌")
    identity = x_device_id or (request.client.host if request.client else "anonymous")
    if not await request.app.state.rate_limiter.allow(identity):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="请求过于频繁")
    return identity


@app.get("/health")
async def health(request: Request) -> dict:
    return {
        "ok": True,
        "service": "deskpet-backend",
        "environment": settings.environment,
        "marketProvider": settings.market_provider,
        "marketFallbackProvider": settings.market_fallback_provider,
        "stockUniverseFallbackProvider": "akshare-sina",
        "professionalDataProvider": settings.professional_data_provider,
        "professionalDataConfigured": bool(
            settings.professional_data_provider == "tushare" and settings.tushare_token
        ),
        "tushareFinancialEnabled": settings.tushare_financial_enabled,
        "officialAnnouncementProvider": settings.official_announcement_provider,
        "quantConfigured": request.app.state.quant is not None,
        "modelConfigured": bool(settings.model_api_key and settings.model_name),
        "routerModel": settings.router_model_name,
        "routerModelConfigured": bool(settings.router_model_api_key and settings.router_model_name),
        "redisConfigured": bool(settings.redis_url),
        "databaseConfigured": bool(settings.database_url),
    }


@app.post("/v1/market/context", response_model=MarketContextResponse)
async def market_context(
    body: MarketContextRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> MarketContextResponse:
    include_events = "news" in body.fields or "announcements" in body.fields
    return await request.app.state.market.context(body.query, body.dailyCount, include_events)


@app.post("/v1/market/sector-scan")
async def sector_scan(
    body: SectorScanRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await request.app.state.market.scan_sectors(body.limit, body.windowDays)


@app.post("/v1/market/stock-screen")
async def stock_screen(
    body: StockScreenRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await request.app.state.market.screen_stocks(body.style, body.limit, deep_limit=body.deepLimit)


def _quant_service(request: Request) -> QuantService:
    quant = request.app.state.quant
    if quant is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="量化服务未配置，请检查 TUSHARE_TOKEN 和 QUANT_DB_PATH",
        )
    return quant


@app.get("/v1/quant/status")
async def quant_status(
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await _quant_service(request).status()


@app.post("/v1/quant/refresh")
async def quant_refresh(
    body: QuantRefreshRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    try:
        return await _quant_service(request).refresh(
            body.startDate,
            body.endDate,
            body.includeValuation,
            refresh_instruments=body.refreshInstruments,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error


@app.post("/v1/quant/factor-screen")
async def factor_screen(
    body: FactorScreenRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await _quant_service(request).screen(body.style, body.limit, body.asOf)


@app.post("/v1/quant/factor-compare")
async def factor_compare(
    body: FactorComparisonRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await _quant_service(request).compare(body.codes, body.style, body.asOf)


@app.post("/v1/quant/backtest")
async def strategy_backtest(
    body: StrategyBacktestRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    try:
        return await _quant_service(request).backtest(
            body.style,
            body.startDate,
            body.endDate,
            body.topN,
            body.rebalanceDays,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error


@app.get("/v1/market/security-events")
async def security_events(
    query: str,
    request: Request,
    days: int = 7,
    limit: int = 10,
    _identity: str = Depends(authorize),
) -> dict:
    return await request.app.state.market.security_events(query, days, limit)


@app.post("/mcp")
async def mcp_endpoint(
    body: Dict[str, Any],
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await handle_mcp_request(request.app.state.market, body, request.app.state.quant)


@app.get("/v1/market/calendar")
async def market_calendar(
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await request.app.state.market.trading_calendar()


@app.get("/v1/market/health")
async def market_health(
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    overview = await request.app.state.market.market_overview()
    available = overview.get("status") == "ok"
    warnings = overview.get("warnings") if isinstance(overview.get("warnings"), list) else []
    degraded = available and (bool(overview.get("stale")) or bool(warnings))
    return {
        "ok": available,
        "status": "degraded" if degraded else "ok" if available else "unavailable",
        "provider": settings.market_provider,
        "fallbackProvider": settings.market_fallback_provider or None,
        "source": overview.get("source"),
        "stale": bool(overview.get("stale")),
        "asOf": overview.get("asOf") or overview.get("dataTime"),
        "warnings": warnings,
        "error": overview.get("error"),
    }


@app.post("/v1/agent/chat")
async def agent_chat(
    body: AgentChatRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> StreamingResponse:
    persisted = await request.app.state.memories.list(_identity)
    body = body.model_copy(update={
        "memories": list(dict.fromkeys([item.content for item in persisted] + body.memories))[:30],
    })
    return StreamingResponse(
        request.app.state.agent.stream(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Request-Id": body.requestId,
        },
    )


@app.post("/v1/research/prepare", response_model=ResearchPrepareResponse)
async def prepare_research(
    body: ResearchPrepareRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> ResearchPrepareResponse:
    return await request.app.state.agent.prepare_research(body)


@app.post("/v1/research/prepare/stream")
async def prepare_research_stream(
    body: ResearchPrepareRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> StreamingResponse:
    return StreamingResponse(
        request.app.state.agent.stream_prepare(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/v1/memories", response_model=list[MemoryRecord])
async def list_memories(
    request: Request,
    identity: str = Depends(authorize),
):
    return await request.app.state.memories.list(identity)


@app.post("/v1/memories", response_model=MemoryRecord)
async def add_memory(
    body: MemoryInput,
    request: Request,
    identity: str = Depends(authorize),
):
    return await request.app.state.memories.add(identity, body.content)


@app.delete("/v1/memories/{memory_id}")
async def remove_memory(
    memory_id: str,
    request: Request,
    identity: str = Depends(authorize),
):
    return {"removed": await request.app.state.memories.remove(identity, memory_id)}
