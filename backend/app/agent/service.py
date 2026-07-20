import asyncio
import json
from typing import AsyncIterator, Dict, List, Tuple, Union

from ..market.service import MarketService
from ..models import AgentChatRequest, ResearchPrepareRequest, ResearchPrepareResponse
from ..research import ResearchService, compact_research_context
from ..roles import get_role
from .model_client import OpenAICompatibleModel


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
            json.dumps(compact_research_context(prepared.context), ensure_ascii=False, separators=(",", ":")),
        ])
    elif prepared.intent == "education":
        lines.append("这是股票知识问题，直接解释核心概念和必要边界，不要虚构实时行情。")
    return "\n".join(lines)


class AgentService:
    def __init__(self, market: MarketService, model: OpenAICompatibleModel):
        self.market = market
        self.research = ResearchService(market)
        self.model = model

    def messages(
        self,
        request: AgentChatRequest,
        prepared: ResearchPrepareResponse,
    ) -> List[Dict[str, str]]:
        profile = get_role(request.roleId)
        identity = [
            profile.systemPrompt,
            f"回答风格：{profile.responseStyle}",
            request.userName and f"用户希望被称为：{request.userName}。",
            request.memories and f"用户明确要求记住：{'；'.join(request.memories)}",
            request.roleId == "stock_expert" and research_prompt(prepared),
        ]
        messages = [{"role": "system", "content": "\n".join(str(item) for item in identity if item)}]
        messages.extend({"role": item.role, "content": item.content} for item in request.history[-20:])
        messages.append({"role": "user", "content": request.text})
        return messages

    async def _prepare_events(
        self,
        request: ResearchPrepareRequest,
    ) -> AsyncIterator[Tuple[str, Union[str, ResearchPrepareResponse]]]:
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
                history=request.history[-6:],
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
            async for delta in self.model.stream(self.messages(request, prepared)):
                yield sse("delta", {"requestId": request.requestId, "text": delta})
            yield sse("done", {"requestId": request.requestId})
        except Exception as error:
            yield sse("error", {
                "requestId": request.requestId,
                "message": str(error)[:500],
            })

    async def close(self) -> None:
        await self.model.close()
