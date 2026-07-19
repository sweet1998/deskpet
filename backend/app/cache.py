import asyncio
import json
import time
from typing import Any, Dict, Optional, Tuple


class TTLCache:
    def __init__(self, redis_url: Optional[str] = None):
        self._redis_url = redis_url
        self._redis = None
        self._memory: Dict[str, Tuple[float, Any]] = {}
        self._lock = asyncio.Lock()

    async def _redis_client(self):
        if not self._redis_url or self._redis is False:
            return None
        if self._redis is None:
            try:
                from redis.asyncio import from_url
                client = from_url(self._redis_url, decode_responses=True)
                await client.ping()
                self._redis = client
            except Exception:
                self._redis = False
        return self._redis or None

    async def get(self, key: str) -> Any:
        client = await self._redis_client()
        if client:
            try:
                value = await client.get(key)
                return json.loads(value) if value is not None else None
            except Exception:
                self._redis = False
        async with self._lock:
            cached = self._memory.get(key)
            if not cached:
                return None
            expires_at, value = cached
            if expires_at <= time.monotonic():
                self._memory.pop(key, None)
                return None
            return value

    async def set(self, key: str, value: Any, ttl: int) -> None:
        client = await self._redis_client()
        if client:
            try:
                await client.set(key, json.dumps(value, ensure_ascii=False), ex=ttl)
                return
            except Exception:
                self._redis = False
        async with self._lock:
            self._memory[key] = (time.monotonic() + ttl, value)

    async def close(self) -> None:
        if self._redis and self._redis is not False:
            await self._redis.aclose()
