import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..models import ChatMessage, StockRouteHint
from ..prompts import (
    COMPLETION_INSTRUCTION,
    COMPLETION_MARKER,
    COMPLETION_VERIFIER_PROMPT,
    CONTINUATION_PROMPT,
    STOCK_ROUTE_SYSTEM_PROMPT,
)


logger = logging.getLogger(__name__)


DEFAULT_MAX_TOKENS = 4096
MAX_AUTO_CONTINUATIONS = 2
MAX_MESSAGES = 24


class ModelConfigurationError(RuntimeError):
    pass


class ModelOutputTruncatedError(RuntimeError):
    pass


class RouteClassificationError(RuntimeError):
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
        current_route: Optional[StockRouteHint] = None,
    ) -> Optional[StockRouteHint]:
        if not self.configured:
            return None
        route_input = {
            "routingStage": "contextual" if history else "current",
            "text": text.strip()[:4000],
            "history": [
                {"role": item.role, "content": item.content.strip()[:1200]}
                for item in history[-6:]
                if item.content.strip()
            ],
            **({
                "currentRoute": current_route.model_dump(exclude_none=True),
            } if current_route is not None else {}),
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
            detail = response.text.replace("\n", " ").strip()[:300]
            logger.warning(
                "stock route request failed with HTTP %s: %s",
                response.status_code,
                detail,
            )
            raise RouteClassificationError(f"语义路由服务请求失败（HTTP {response.status_code}）")
        try:
            content = response.json()["choices"][0]["message"]["content"]
            content = re.sub(r"<think>[\s\S]*?</think>", "", str(content), flags=re.IGNORECASE)
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE)
            route = StockRouteHint.model_validate_json(content)
            if route.scope == "out_of_scope":
                return route.model_copy(update={
                    "intent": "out_of_scope",
                    "targetKind": "none",
                    "requiresResearch": False,
                })
            if route.relation == "answer_explanation" or route.intent == "answer_followup":
                return route.model_copy(update={
                    "intent": "answer_followup",
                    "targetKind": "knowledge",
                    "requiresResearch": False,
                })
            return route
        except (KeyError, IndexError, TypeError, ValueError) as error:
            logger.warning("stock route response validation failed: %s", type(error).__name__)
            raise RouteClassificationError("语义路由服务返回了无效的结构化结果") from error

    async def stream(
        self,
        messages: List[Dict[str, Any]],
        max_tokens: int = 1400,
    ) -> AsyncIterator[str]:
        if not self.api_key or not self.model:
            raise ModelConfigurationError("后端尚未配置 MODEL_API_KEY 和 MODEL_NAME")
        conversation = self._with_completion_contract(messages)
        question = self._latest_user_text(messages)
        answer = ""

        for continuation in range(MAX_AUTO_CONTINUATIONS + 1):
            part = ""
            pending = ""
            marker_seen = False
            limited = self._limited_messages(conversation)
            try:
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
                            delta = body.get("choices", [{}])[0].get("delta", {}).get("content")
                            if not delta or marker_seen:
                                continue
                            text = str(delta)
                            part += text
                            pending += text
                            marker_index = pending.find(COMPLETION_MARKER)
                            if marker_index >= 0:
                                if marker_index:
                                    yield pending[:marker_index]
                                part = part[:part.find(COMPLETION_MARKER)]
                                pending = ""
                                marker_seen = True
                                continue
                            safe_length = len(pending) - (len(COMPLETION_MARKER) - 1)
                            if safe_length > 0:
                                yield pending[:safe_length]
                                pending = pending[safe_length:]
                        except (ValueError, IndexError, AttributeError):
                            continue
            except httpx.HTTPError:
                if not part:
                    raise

            answer += part
            if marker_seen and self._has_natural_ending(answer) and await self._verify_completion(question, answer):
                return
            if pending:
                yield pending
            if continuation == MAX_AUTO_CONTINUATIONS:
                raise ModelOutputTruncatedError("回答未完整结束，自动续写后仍未收到完成标记")
            conversation.extend([
                {"role": "assistant", "content": part},
                {"role": "user", "content": CONTINUATION_PROMPT},
            ])

    @staticmethod
    def _has_natural_ending(answer: str) -> bool:
        return bool(re.search(r"[。！？.!?][”’\"')）】\]]?$", answer.strip()))

    async def _verify_completion(self, question: str, answer: str) -> bool:
        if not answer.strip():
            return False
        try:
            response = await self.client.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": COMPLETION_VERIFIER_PROMPT},
                        {"role": "user", "content": json.dumps({
                            "question": question[:4000],
                            "answer": answer[-8000:],
                        }, ensure_ascii=False)},
                    ],
                    "temperature": 0,
                    "max_tokens": 80,
                    "stream": False,
                    "response_format": {"type": "json_object"},
                },
            )
            if response.status_code >= 400:
                return False
            content = response.json()["choices"][0]["message"]["content"]
            source = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(content).strip(), flags=re.IGNORECASE)
            return json.loads(source).get("complete") is True
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError):
            return False

    @staticmethod
    def _latest_user_text(messages: List[Dict[str, Any]]) -> str:
        for message in reversed(messages):
            if message.get("role") != "user":
                continue
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "\n".join(
                    str(part.get("text"))
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
                )
        return ""

    @staticmethod
    def _with_completion_contract(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        conversation = [dict(message) for message in messages]
        for message in conversation:
            if message.get("role") == "system" and isinstance(message.get("content"), str):
                message["content"] = f"{message['content']}\n{COMPLETION_INSTRUCTION}"
                break
        else:
            conversation.insert(0, {"role": "system", "content": COMPLETION_INSTRUCTION})
        return conversation

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
