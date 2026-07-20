import asyncio
from contextlib import asynccontextmanager, suppress
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .agent.model_client import OpenAICompatibleModel
from .agent.service import AgentService
from .cache import TTLCache
from .config import settings
from .market.providers import AkshareProvider, EastmoneyProvider, TencentProvider
from .market.service import MarketService
from .memory import MemoryRepository
from .models import (
    AgentChatRequest,
    MarketContextRequest,
    MarketContextResponse,
    MemoryInput,
    MemoryRecord,
    ResearchPrepareRequest,
    ResearchPrepareResponse,
    SectorScanRequest,
)
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
    cache = TTLCache(settings.redis_url)
    provider = provider_type(timeout=settings.market_request_timeout)
    fallback = (
        fallback_type(timeout=settings.market_request_timeout)
        if fallback_type and fallback_type is not provider_type
        else None
    )
    market = MarketService(
        provider,
        cache,
        fallback,
    )
    model = OpenAICompatibleModel(
        base_url=settings.model_base_url,
        api_key=settings.model_api_key,
        model=settings.model_name,
        timeout=settings.model_timeout,
    )
    return market, AgentService(market, model)


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
    market, agent = create_services()
    app.state.market = market
    app.state.agent = agent
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
async def health() -> dict:
    return {
        "ok": True,
        "service": "deskpet-backend",
        "environment": settings.environment,
        "marketProvider": settings.market_provider,
        "marketFallbackProvider": settings.market_fallback_provider,
        "modelConfigured": bool(settings.model_api_key and settings.model_name),
        "redisConfigured": bool(settings.redis_url),
        "databaseConfigured": bool(settings.database_url),
    }


@app.post("/v1/market/context", response_model=MarketContextResponse)
async def market_context(
    body: MarketContextRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> MarketContextResponse:
    return await request.app.state.market.context(body.query, body.dailyCount)


@app.post("/v1/market/sector-scan")
async def sector_scan(
    body: SectorScanRequest,
    request: Request,
    _identity: str = Depends(authorize),
) -> dict:
    return await request.app.state.market.scan_sectors(body.limit, body.windowDays)


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
    return await request.app.state.agent.research.prepare(body)


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
