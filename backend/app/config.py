import os
from dataclasses import dataclass
from typing import List, Optional


def _csv(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    environment: str
    api_token: str
    cors_origins: List[str]
    market_provider: str
    market_fallback_provider: Optional[str]
    market_request_timeout: float
    redis_url: Optional[str]
    database_url: Optional[str]
    model_base_url: str
    model_api_key: str
    model_name: str
    model_timeout: float
    rate_limit_per_minute: int

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            environment=os.getenv("DESKPET_ENV", "development"),
            api_token=os.getenv("DESKPET_API_TOKEN", ""),
            cors_origins=_csv(os.getenv(
                "DESKPET_CORS_ORIGINS",
                "http://127.0.0.1:5173,http://localhost:5173",
            )),
            market_provider=os.getenv("MARKET_PROVIDER", "akshare"),
            market_fallback_provider=os.getenv("MARKET_FALLBACK_PROVIDER", "tencent") or None,
            market_request_timeout=float(os.getenv("MARKET_REQUEST_TIMEOUT", "8")),
            redis_url=os.getenv("REDIS_URL") or None,
            database_url=os.getenv("DATABASE_URL") or None,
            model_base_url=os.getenv(
                "MODEL_BASE_URL",
                "https://ark.cn-beijing.volces.com/api/v3",
            ).rstrip("/"),
            model_api_key=os.getenv("MODEL_API_KEY", ""),
            model_name=os.getenv("MODEL_NAME", ""),
            model_timeout=float(os.getenv("MODEL_TIMEOUT", "60")),
            rate_limit_per_minute=max(1, int(os.getenv("RATE_LIMIT_PER_MINUTE", "30"))),
        )


settings = Settings.from_env()
