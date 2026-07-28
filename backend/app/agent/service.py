import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple, Union

from ..market.service import CODE_PATTERN, MarketService
from ..models import AgentChatRequest, ResearchPrepareRequest, ResearchPrepareResponse
from ..prompts import (
    build_current_date_prompt,
    build_research_prompt,
    build_role_system_prompt,
    build_trading_calendar_prompt,
)
from ..research import (
    CONSTITUENT_FOLLOWUP_PATTERN,
    ResearchService,
    compact_research_context,
    research_context_unavailable,
    starts_new_topic,
)
from ..roles import get_role
from .model_client import ModelOutputTruncatedError, OpenAICompatibleModel


def sse(event: str, data: Dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


_WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


def _current_date_context() -> str:
    now = datetime.now(timezone(timedelta(hours=8)))
    label = f"{now.year}年{now.month}月{now.day}日 {_WEEKDAYS[now.weekday()]}"
    return build_current_date_prompt(label)


def research_prompt(prepared: ResearchPrepareResponse) -> str:
    context = compact_research_context(prepared.context) if prepared.context else None
    return build_research_prompt(prepared.intent, context, prepared.skills)


class AgentService:
    def __init__(
        self,
        market: MarketService,
        model: OpenAICompatibleModel,
        intent_model: Optional[OpenAICompatibleModel] = None,
    ):
        self.market = market
        self.research = ResearchService(market)
        self.model = model
        self.intent_model = intent_model or model

    def messages(
        self,
        request: AgentChatRequest,
        prepared: ResearchPrepareResponse,
        date_context: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        profile = get_role(request.roleId)
        system_prompt = build_role_system_prompt(
            profile,
            date_context or _current_date_context(),
            request.userName,
            request.memories,
            research_prompt(prepared) if request.roleId == "stock_expert" else None,
        )
        messages = [{"role": "system", "content": system_prompt}]
        history = [] if starts_new_topic(request.text) else request.history[-20:]
        for index in range(len(history) - 1, -1, -1):
            if history[index].role == "user" and starts_new_topic(history[index].content):
                history = history[index:]
                break
        messages.extend({"role": item.role, "content": item.content} for item in history)
        user_content: Union[str, List[Dict[str, Any]]] = request.text
        if request.image:
            user_content = [
                {"type": "text", "text": request.text},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{request.image.mimeType};base64,{request.image.base64}",
                        "detail": "high",
                    },
                },
            ]
        messages.append({"role": "user", "content": user_content})
        return messages

    async def _date_context(self, role_id: str) -> str:
        if role_id != "stock_expert":
            return _current_date_context()
        calendar_fn = getattr(self.market, "trading_calendar", None)
        if calendar_fn is None:
            return _current_date_context()
        try:
            calendar = await calendar_fn()
        except Exception:
            return _current_date_context()
        return build_trading_calendar_prompt(calendar) or _current_date_context()

    async def _prepare_events(
        self,
        request: ResearchPrepareRequest,
    ) -> AsyncIterator[Tuple[str, Union[str, ResearchPrepareResponse]]]:
        request = await self._with_model_route(request)
        queue: asyncio.Queue[str] = asyncio.Queue()
        task = asyncio.create_task(self.research.prepare(request, queue.put))
        try:
            while not task.done() or not queue.empty():
                try:
                    text = queue.get_nowait() if not queue.empty() else await asyncio.wait_for(
                        queue.get(),
                        timeout=0.05,
                    )
                except asyncio.TimeoutError:
                    continue
                yield "reasoning", text
            yield "result", await task
        finally:
            if not task.done():
                task.cancel()

    async def _with_model_route(self, request: ResearchPrepareRequest) -> ResearchPrepareRequest:
        explicit_code = bool(CODE_PATTERN.search(request.text))
        contextual_constituent_followup = bool(
            request.history and CONSTITUENT_FOLLOWUP_PATTERN.search(request.text)
        )
        if (
            request.roleId != "stock_expert"
            or request.routeHint is not None
            or contextual_constituent_followup
            or explicit_code
            or not getattr(self.intent_model, "configured", False)
        ):
            return request
        try:
            route = await self.intent_model.classify_stock_intent(request.text, request.history[-20:])
        except Exception:
            route = None
        return request.model_copy(update={"routeHint": route}) if route else request

    async def prepare_research(self, request: ResearchPrepareRequest) -> ResearchPrepareResponse:
        return await self.research.prepare(await self._with_model_route(request))

    async def stream_prepare(self, request: ResearchPrepareRequest) -> AsyncIterator[str]:
        try:
            async for event, value in self._prepare_events(request):
                if event == "reasoning":
                    yield sse("reasoning", {"text": value})
                else:
                    prepared = value
                    assert isinstance(prepared, ResearchPrepareResponse)
                    yield sse("result", prepared.model_dump(exclude_none=True))
        except Exception as error:
            yield sse("error", {"message": str(error)[:500]})

    async def stream(self, request: AgentChatRequest) -> AsyncIterator[str]:
        yield sse("state", {
            "requestId": request.requestId,
            "state": "thinking",
            "progress": 10,
            "step": "正在判断问题类型",
            "interruptible": True,
        })
        prepared = None
        executing = False
        try:
            async for event, value in self._prepare_events(ResearchPrepareRequest(
                text=request.text,
                roleId=request.roleId,
                history=request.history[-20:],
            )):
                if event == "reasoning":
                    if not executing:
                        executing = True
                        yield sse("state", {
                            "requestId": request.requestId,
                            "state": "executing",
                            "progress": 35,
                            "step": "正在获取并计算研究数据",
                            "interruptible": True,
                        })
                    yield sse("reasoning", {
                        "requestId": request.requestId,
                        "text": value,
                    })
                else:
                    assert isinstance(value, ResearchPrepareResponse)
                    prepared = value
        except Exception as error:
            yield sse("error", {
                "requestId": request.requestId,
                "message": str(error)[:500],
            })
            return
        assert prepared is not None
        yield sse("research", {
            "requestId": request.requestId,
            **prepared.model_dump(exclude_none=True),
        })

        if prepared.scope == "needs_clarification":
            yield sse("result", {
                "requestId": request.requestId,
                "text": prepared.reply or "请补充更明确的 A 股研究问题。",
            })
            yield sse("done", {"requestId": request.requestId})
            return

        if prepared.reply:
            yield sse("result", {
                "requestId": request.requestId,
                "text": prepared.reply,
            })
            yield sse("done", {"requestId": request.requestId})
            return

        if request.roleId == "stock_expert" and research_context_unavailable(prepared):
            yield sse("result", {
                "requestId": request.requestId,
                "text": "当前行情数据源暂时不可用，无法可靠回答这个问题。请稍后重试。",
            })
            yield sse("done", {"requestId": request.requestId})
            return

        if prepared.requiresResearch and not executing:
            yield sse("state", {
                "requestId": request.requestId,
                "state": "executing",
                "progress": 55,
                "step": "正在汇总研究数据",
                "interruptible": True,
            })
        yield sse("state", {
            "requestId": request.requestId,
            "state": "speaking",
            "progress": 75,
            "step": "正在组织回答",
            "interruptible": True,
        })
        try:
            max_tokens = 4096 if prepared.requiresResearch else 2048
            date_context = await self._date_context(request.roleId)
            async for delta in self.model.stream(
                self.messages(request, prepared, date_context),
                max_tokens=max_tokens,
            ):
                yield sse("delta", {"requestId": request.requestId, "text": delta})
            yield sse("done", {"requestId": request.requestId})
        except ModelOutputTruncatedError:
            yield sse("truncated", {"requestId": request.requestId})
            yield sse("done", {"requestId": request.requestId})
        except Exception as error:
            yield sse("error", {
                "requestId": request.requestId,
                "message": str(error)[:500],
            })

    async def close(self) -> None:
        await self.model.close()
        if self.intent_model is not self.model:
            await self.intent_model.close()
