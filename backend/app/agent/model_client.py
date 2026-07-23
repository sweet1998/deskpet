import json
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx


class ModelConfigurationError(RuntimeError):
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

    async def stream(self, messages: List[Dict[str, Any]]) -> AsyncIterator[str]:
        if not self.api_key or not self.model:
            raise ModelConfigurationError("后端尚未配置 MODEL_API_KEY 和 MODEL_NAME")
        async with self.client.stream(
            "POST",
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "messages": messages[-22:],
                "temperature": 0.55,
                "max_tokens": 1600,
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
                    if delta:
                        yield str(delta)
                except (ValueError, IndexError, AttributeError):
                    continue

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
