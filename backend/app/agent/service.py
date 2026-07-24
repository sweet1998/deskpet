import asyncio
import json
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple, Union

from ..market.service import CODE_PATTERN, MarketService
from ..models import AgentChatRequest, ResearchPrepareRequest, ResearchPrepareResponse
from ..research import (
    CONSTITUENT_FOLLOWUP_PATTERN,
    ROLE_CAPABILITY_PATTERN,
    ResearchService,
    compact_research_context,
    research_context_unavailable,
    starts_new_topic,
)
from ..roles import get_role
from .model_client import ModelOutputTruncatedError, OpenAICompatibleModel


def sse(event: str, data: Dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


def research_prompt(prepared: ResearchPrepareResponse) -> str:
    lines = [
        f"本次问题意图：{prepared.intent}。",
        "像熟悉市场的同事一样直接回应用户最关心的点。短问题就短答，不要默认使用标题、编号、固定段落或总结套话。",
        "不要复述问题，不要用“综合来看”“基于以上分析”开场，也不要为了显得全面而补充用户没问的内容。",
    ]
    if prepared.context:
        lines.extend([
            "以下 JSON 是精简后的研究事实。只引用与问题直接相关的数据；时效会影响判断时再自然说明时间和来源，缺失项只有影响答案时才提，不得补造数据。",
            "严格按数据自身日期描述：没有当日快照时，只能说“最近一个数据日”或给出具体日期；不得写“今天”“当前”“盘中”“实时”。历史区间的结束日期不是实时行情时间。",
            json.dumps(compact_research_context(prepared.context), ensure_ascii=False, separators=(",", ":")),
        ])
    elif prepared.intent == "education":
        lines.append("这是股票知识问题，直接解释核心概念和必要边界，不要虚构实时行情。")
    elif prepared.intent == "role_capability":
        lines.append(
            "这是角色身份或能力问题。根据用户的具体问法自然回答：问“你是谁”时先介绍当前角色身份，"
            "问“会什么”时说明能提供的帮助；结合最近对话，但不要逐字复用上一条能力介绍。不要查询或编造行情。"
        )
    elif prepared.intent == "answer_followup":
        lines.append(
            "这是用户针对你上一条回答提出的解释性追问。结合最近对话直接解释上一条说法、依据和数据边界；"
            "不要重新要求股票代码。若上一条说法不准确或依据不足，应明确纠正。"
        )
    return "\n".join(lines)


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
    ) -> List[Dict[str, Any]]:
        profile = get_role(request.roleId)
        identity = [
            profile.systemPrompt,
            f"回答风格：{profile.responseStyle}",
            request.userName and f"用户希望被称为：{request.userName}。",
            request.memories and f"用户明确要求记住：{'；'.join(request.memories)}",
            request.roleId == "stock_expert" and research_prompt(prepared),
        ]
        messages = [{"role": "system", "content": "\n".join(str(item) for item in identity if item)}]
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
        explicit_market_scope = any(word.lower() in request.text.lower() for word in (
            "股票", "个股", "板块", "行业", "概念", "指数", "大盘", "A股", "股市", "行情",
        ))
        context_dependent = any(word in request.text for word in (
            "你说", "刚才", "上面", "前面", "上一条", "这个结论", "这个判断", "为什么这么说", "依据是什么",
        ))
        if (
            request.roleId != "stock_expert"
            or request.routeHint is not None
            or ROLE_CAPABILITY_PATTERN.search(request.text)
            or contextual_constituent_followup
            or ((explicit_code or explicit_market_scope) and not context_dependent)
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

        if prepared.scope != "in_scope":
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
            max_tokens = 4096 if prepared.requiresResearch else 2048 if request.image else 1400
            async for delta in self.model.stream(self.messages(request, prepared), max_tokens=max_tokens):
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
