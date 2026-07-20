from abc import ABC, abstractmethod
from typing import Any, Dict, List


class MarketProvider(ABC):
    name = "unknown"

    @abstractmethod
    async def search(self, query: str) -> List[Dict[str, str]]:
        raise NotImplementedError

    @abstractmethod
    async def snapshot(self, code: str) -> Dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def daily_bars(self, code: str, count: int) -> List[Dict[str, Any]]:
        raise NotImplementedError

    async def company_profile(self, code: str) -> Dict[str, Any]:
        return {}

    async def financial_snapshot(self, code: str) -> Dict[str, Any]:
        return {}

    async def sector_catalog(self, category: str) -> List[Dict[str, Any]]:
        return []

    async def sector_scan_snapshot(self, category: str) -> List[Dict[str, Any]]:
        return []

    async def sector_snapshot(self, category: str, code: str, name: str) -> Dict[str, Any]:
        return {}

    async def sector_bars(self, category: str, name: str, count: int) -> List[Dict[str, Any]]:
        return []

    async def sector_constituents(self, category: str, code: str, name: str) -> List[Dict[str, Any]]:
        return []

    async def index_snapshot(self, code: str, category: str) -> Dict[str, Any]:
        return {}

    async def index_bars(self, symbol: str, count: int) -> List[Dict[str, Any]]:
        return []

    async def market_overview(self) -> Dict[str, Any]:
        return {}

    async def close(self) -> None:
        return None
