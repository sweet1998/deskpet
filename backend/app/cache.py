import asyncio
import json
import os
import sqlite3
import time
from typing import Any, Dict, Optional, Tuple


class TTLCache:
    def __init__(
        self,
        redis_url: Optional[str] = None,
        disk_path: Optional[str] = None,
        max_memory_entries: int = 512,
        max_disk_entries: int = 2000,
    ):
        self._redis_url = redis_url
        self._disk_path = disk_path
        self._max_memory_entries = max(1, max_memory_entries)
        self._max_disk_entries = max(1, max_disk_entries)
        self._redis = None
        self._memory: Dict[str, Tuple[float, float, Any]] = {}
        self._lock = asyncio.Lock()
        self._disk_lock = asyncio.Lock()

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
                if value is not None:
                    return json.loads(value)
            except Exception:
                self._redis = False
        async with self._lock:
            cached = self._memory.get(key)
            if cached:
                expires_at, _, value = cached
                if expires_at > time.monotonic():
                    return value
        return await self._disk_get(key, allow_stale=False)

    async def set(self, key: str, value: Any, ttl: int) -> None:
        client = await self._redis_client()
        if client:
            try:
                await client.set(key, json.dumps(value, ensure_ascii=False), ex=ttl)
            except Exception:
                self._redis = False
        async with self._lock:
            self._memory[key] = (time.monotonic() + ttl, time.time(), value)
            if len(self._memory) > self._max_memory_entries:
                oldest = sorted(
                    self._memory,
                    key=lambda item: self._memory[item][1],
                )[:len(self._memory) - self._max_memory_entries]
                for item in oldest:
                    self._memory.pop(item, None)
        await self._disk_set(key, value, ttl)

    async def get_stale(self, key: str, max_age: int) -> Any:
        async with self._lock:
            cached = self._memory.get(key)
            if cached:
                _, stored_at, value = cached
                if time.time() - stored_at <= max_age:
                    return value
        return await self._disk_get(key, allow_stale=True, max_age=max_age)

    async def _disk_get(self, key: str, allow_stale: bool, max_age: int = 0) -> Any:
        if not self._disk_path:
            return None

        def read() -> Any:
            try:
                with sqlite3.connect(self._disk_path, timeout=2) as connection:
                    self._ensure_table(connection)
                    row = connection.execute(
                        "SELECT stored_at, expires_at, value FROM cache WHERE key = ?",
                        (key,),
                    ).fetchone()
                    if not row:
                        return None
                    stored_at, expires_at, payload = row
                    now = time.time()
                    if expires_at > now or (allow_stale and now - stored_at <= max_age):
                        return json.loads(payload)
                    if now - stored_at > max(max_age, 7 * 24 * 60 * 60):
                        connection.execute("DELETE FROM cache WHERE key = ?", (key,))
                    return None
            except Exception:
                return None

        async with self._disk_lock:
            return await asyncio.to_thread(read)

    async def _disk_set(self, key: str, value: Any, ttl: int) -> None:
        if not self._disk_path:
            return
        try:
            payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return

        def write() -> None:
            try:
                os.makedirs(os.path.dirname(self._disk_path) or ".", exist_ok=True)
                now = time.time()
                with sqlite3.connect(self._disk_path, timeout=2) as connection:
                    self._ensure_table(connection)
                    connection.execute(
                        "INSERT INTO cache(key, stored_at, expires_at, value) VALUES(?, ?, ?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET stored_at=excluded.stored_at, "
                        "expires_at=excluded.expires_at, value=excluded.value",
                        (key, now, now + ttl, payload),
                    )
                    connection.execute(
                        "DELETE FROM cache WHERE stored_at < ?",
                        (now - 7 * 24 * 60 * 60,),
                    )
                    connection.execute(
                        "DELETE FROM cache WHERE key IN ("
                        "SELECT key FROM cache ORDER BY stored_at DESC LIMIT -1 OFFSET ?)",
                        (self._max_disk_entries,),
                    )
            except Exception:
                return

        async with self._disk_lock:
            await asyncio.to_thread(write)

    @staticmethod
    def _ensure_table(connection: sqlite3.Connection) -> None:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS cache ("
            "key TEXT PRIMARY KEY, stored_at REAL NOT NULL, "
            "expires_at REAL NOT NULL, value TEXT NOT NULL)"
        )

    async def close(self) -> None:
        if self._redis and self._redis is not False:
            await self._redis.aclose()
