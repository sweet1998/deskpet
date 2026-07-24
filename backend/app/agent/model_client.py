import json
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx


DEFAULT_MAX_TOKENS = 4096
MAX_AUTO_CONTINUATIONS = 1
MAX_MESSAGES = 24
CONTINUATION_PROMPT = "刚才的回答因长度限制中断。请从中断处直接续写，不要重复已经回答的内容，直到完整结束。"


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
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(timeout=timeout)

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
