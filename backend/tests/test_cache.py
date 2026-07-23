import sqlite3
import time

import pytest

from app.cache import TTLCache


@pytest.mark.asyncio
async def test_disk_cache_survives_process_memory_recreation(tmp_path):
    cache_path = tmp_path / "market-cache.sqlite3"
    first = TTLCache(disk_path=str(cache_path))
    await first.set("snapshot", {"price": 10.5}, 60)

    second = TTLCache(disk_path=str(cache_path))
    assert await second.get("snapshot") == {"price": 10.5}


@pytest.mark.asyncio
async def test_expired_disk_value_is_only_available_through_bounded_stale_read(tmp_path):
    cache_path = tmp_path / "market-cache.sqlite3"
    cache = TTLCache(disk_path=str(cache_path))
    await cache.set("snapshot", {"price": 10.5}, 60)
    with sqlite3.connect(cache_path) as connection:
        connection.execute(
            "UPDATE cache SET stored_at = ?, expires_at = ? WHERE key = ?",
            (time.time() - 120, time.time() - 60, "snapshot"),
        )

    fresh_process = TTLCache(disk_path=str(cache_path))
    assert await fresh_process.get("snapshot") is None
    assert await fresh_process.get_stale("snapshot", 3600) == {"price": 10.5}
    assert await fresh_process.get_stale("snapshot", 30) is None


@pytest.mark.asyncio
async def test_memory_and_disk_cache_have_entry_limits(tmp_path):
    cache_path = tmp_path / "market-cache.sqlite3"
    cache = TTLCache(
        disk_path=str(cache_path),
        max_memory_entries=2,
        max_disk_entries=2,
    )
    await cache.set("first", {"value": 1}, 60)
    await cache.set("second", {"value": 2}, 60)
    await cache.set("third", {"value": 3}, 60)

    assert len(cache._memory) == 2
    assert "first" not in cache._memory
    with sqlite3.connect(cache_path) as connection:
        keys = {row[0] for row in connection.execute("SELECT key FROM cache")}
    assert keys == {"second", "third"}
