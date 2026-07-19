import asyncio
from typing import Dict, List, Optional
import uuid

from .models import MemoryRecord


class MemoryRepository:
    def __init__(self, database_url: Optional[str] = None):
        self.database_url = database_url
        self._engine = None
        self._session_factory = None
        self._memory: Dict[str, List[MemoryRecord]] = {}
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        if not self.database_url:
            return
        from sqlalchemy import String, UniqueConstraint
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

        class Base(DeclarativeBase):
            pass

        class UserMemory(Base):
            __tablename__ = "user_memories"
            __table_args__ = (UniqueConstraint("owner_id", "content"),)
            id: Mapped[str] = mapped_column(String(36), primary_key=True)
            owner_id: Mapped[str] = mapped_column(String(160), index=True)
            content: Mapped[str] = mapped_column(String(500))

        self._record_model = UserMemory
        self._engine = create_async_engine(self.database_url, pool_pre_ping=True)
        self._session_factory = async_sessionmaker(self._engine, expire_on_commit=False)
        async with self._engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def list(self, owner_id: str) -> List[MemoryRecord]:
        if not self._session_factory:
            async with self._lock:
                return list(self._memory.get(owner_id, []))
        from sqlalchemy import select
        async with self._session_factory() as session:
            result = await session.execute(
                select(self._record_model).where(self._record_model.owner_id == owner_id)
            )
            return [MemoryRecord(id=row.id, content=row.content) for row in result.scalars()]

    async def add(self, owner_id: str, content: str) -> MemoryRecord:
        normalized = content.strip()[:500]
        existing = await self.list(owner_id)
        duplicate = next((item for item in existing if item.content == normalized), None)
        if duplicate:
            return duplicate
        record = MemoryRecord(id=str(uuid.uuid4()), content=normalized)
        if not self._session_factory:
            async with self._lock:
                self._memory.setdefault(owner_id, []).append(record)
            return record
        async with self._session_factory() as session:
            session.add(self._record_model(id=record.id, owner_id=owner_id, content=record.content))
            await session.commit()
        return record

    async def remove(self, owner_id: str, memory_id: str) -> bool:
        if not self._session_factory:
            async with self._lock:
                values = self._memory.get(owner_id, [])
                before = len(values)
                self._memory[owner_id] = [item for item in values if item.id != memory_id]
                return len(self._memory[owner_id]) != before
        from sqlalchemy import delete
        async with self._session_factory() as session:
            result = await session.execute(
                delete(self._record_model).where(
                    self._record_model.owner_id == owner_id,
                    self._record_model.id == memory_id,
                )
            )
            await session.commit()
            return bool(result.rowcount)

    async def close(self) -> None:
        if self._engine:
            await self._engine.dispose()
