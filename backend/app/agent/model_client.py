import json
import re
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..models import ChatMessage, StockRouteHint


DEFAULT_MAX_TOKENS = 4096
MAX_AUTO_CONTINUATIONS = 1
MAX_MESSAGES = 24
CONTINUATION_PROMPT = "刚才的回答因长度限制中断。请从中断处直接续写，不要重复已经回答的内容，直到完整结束。"
STOCK_ROUTE_SYSTEM_PROMPT = """你是 A 股桌面助手的请求路由器，只输出一个 JSON 对象，不回答用户问题。
字段固定为 scope、intent、relation、targetKind、targetTerms、requiresResearch、confidence。
scope 只能是 in_scope、needs_clarification、out_of_scope。
intent 只能是 security_quote、security_trend、fundamental、valuation、comparison、sector_snapshot、sector、sector_scan、index、market_snapshot、market、education、role_capability、answer_followup、clarification、out_of_scope。
relation 只能是 standalone、followup、answer_explanation、new_topic。
targetKind 只能是 security、sector、index、market、knowledge、none。
targetTerms 最多 3 个，只能逐字复制当前问题或历史中出现的股票、板块或指数名称，不得生成代码或改写名称。
简单报价、知识解释、澄清、越界和解释上一条回答不需要研究；趋势、基本面、估值、对比、板块筛选和原因分析需要研究。
个股、A 股板块、指数、大盘和股票知识属于范围内；天气、编程、生活、基金、债券、期货、外汇、加密货币和海外股票属于范围外。
询问当前角色是谁、会什么、擅长什么或能提供哪些帮助时，返回 role_capability，属于范围内且不需要研究。
针对上一条回答的质疑或解释请求属于 answer_followup；结合历史识别指代和新话题。
“上涨的是哪几家”“领跌的是谁”“还有哪些”等省略标的的问题，如果历史正在讨论股票或板块，属于范围内的 followup，必须继承历史目标，不能判为 out_of_scope。confidence 是 0 到 1 的数字。"""


class ModelConfigurationError(RuntimeError):
    pass


class ModelOutputTruncatedError(RuntimeError):
    pass


class OpenAICompatibleModel:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 60,
        client: Optional[httpx.AsyncClient] = None,
        route_extra_body: Optional[Dict[str, Any]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.route_extra_body = dict(route_extra_body or {})
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(timeout=timeout)

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.model)

    async def classify_stock_intent(
        self,
        text: str,
        history: List[ChatMessage],
    ) -> Optional[StockRouteHint]:
        if not self.configured:
            return None
        route_input = {
            "text": text.strip()[:4000],
            "history": [
                {"role": item.role, "content": item.content.strip()[:1200]}
                for item in history[-6:]
                if item.content.strip()
            ],
        }
        response = await self.client.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": STOCK_ROUTE_SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps(route_input, ensure_ascii=False)},
                ],
                "temperature": 0,
                "max_tokens": 350,
                "stream": False,
                "response_format": {"type": "json_object"},
                **self.route_extra_body,
            },
            timeout=self.client.timeout,
        )
        if response.status_code >= 400:
            return None
        try:
            content = response.json()["choices"][0]["message"]["content"]
            content = re.sub(r"<think>[\s\S]*?</think>", "", str(content), flags=re.IGNORECASE)
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE)
            return StockRouteHint.model_validate_json(content)
        except (KeyError, IndexError, TypeError, ValueError):
            return None

    async def stream(
        self,
        messages: List[Dict[str, Any]],
        max_tokens: int = 1400,
    ) -> AsyncIterator[str]:
        if not self.api_key or not self.model:
            raise ModelConfigurationError("后端尚未配置 MODEL_API_KEY 和 MODEL_NAME")
        conversation = list(messages)

        for continuation in range(MAX_AUTO_CONTINUATIONS + 1):
            finish_reason = ""
            part = ""
            limited = self._limited_messages(conversation)
            async with self.client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": limited,
                    "temperature": 0.55,
                    "max_tokens": max(512, min(DEFAULT_MAX_TOKENS, max_tokens)),
                    "stream": True,
                },
            ) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", errors="replace")
                    raise RuntimeError(f"模型请求失败（HTTP {response.status_code}）：{body[:300]}")
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    try:
                        body = json.loads(payload)
                        choice = body.get("choices", [{}])[0]
                        if choice.get("finish_reason"):
                            finish_reason = str(choice["finish_reason"])
                        delta = choice.get("delta", {}).get("content")
                        if delta:
                            text = str(delta)
                            part += text
                            yield text
                    except (ValueError, IndexError, AttributeError):
                        continue

            if finish_reason != "length":
                return
            if continuation == MAX_AUTO_CONTINUATIONS:
                raise ModelOutputTruncatedError("回答内容过长，自动续写后仍达到模型输出上限")
            conversation.extend([
                {"role": "assistant", "content": part},
                {"role": "user", "content": CONTINUATION_PROMPT},
            ])

    @staticmethod
    def _limited_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if len(messages) <= MAX_MESSAGES:
            return messages
        if messages and messages[0].get("role") == "system":
            return [messages[0], *messages[-(MAX_MESSAGES - 1):]]
        return messages[-MAX_MESSAGES:]

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
