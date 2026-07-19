import json
from typing import AsyncIterator, Dict, List

from ..market.service import MarketService
from ..models import AgentChatRequest, ResearchPrepareRequest, ResearchPrepareResponse
from ..research import ResearchService
from ..roles import get_role
from .model_client import OpenAICompatibleModel


def sse(event: str, data: Dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


def research_prompt(prepared: ResearchPrepareResponse) -> str:
    lines = [
        f"本次问题意图：{prepared.intent}。",
        "根据用户的具体问题自由组织答案，不得套用固定章节，也不要展示内部推理链。",
    ]
    if prepared.context:
        lines.extend([
            "以下 JSON 是服务端准备的结构化研究数据。只使用与当前问题相关的字段；必须说明数据时间、实际来源和 warnings，不得补造缺失数据。",
            json.dumps(prepared.context, ensure_ascii=False, separators=(",", ":")),
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

    async def stream(self, request: AgentChatRequest) -> AsyncIterator[str]:
        yield sse("state", {
            "requestId": request.requestId,
            "state": "thinking",
            "progress": 10,
            "step": "正在判断问题类型",
            "interruptible": True,
        })
        prepared = await self.research.prepare(ResearchPrepareRequest(
            text=request.text,
            roleId=request.roleId,
            history=request.history[-6:],
        ))
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

        if prepared.requiresResearch:
            yield sse("state", {
                "requestId": request.requestId,
                "state": "executing",
                "progress": 55,
                "step": "正在汇总研究数据",
                "interruptible": True,
            })
            for thought in prepared.thoughts:
                yield sse("reasoning", {
                    "requestId": request.requestId,
                    "text": thought,
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
