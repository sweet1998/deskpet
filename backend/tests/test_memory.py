import pytest

from app.memory import MemoryRepository


@pytest.mark.asyncio
async def test_memory_is_shared_and_deduplicated_by_owner():
    repository = MemoryRepository()
    first = await repository.add("device-a", "周五交周报")
    duplicate = await repository.add("device-a", "周五交周报")
    await repository.add("device-b", "另一个用户")

    assert first.id == duplicate.id
    assert [item.content for item in await repository.list("device-a")] == ["周五交周报"]
    assert await repository.remove("device-a", first.id) is True
    assert await repository.list("device-a") == []
