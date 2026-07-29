import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)


def _csv(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    environment: str
    api_token: str
    cors_origins: List[str]
    market_provider: str
    market_fallback_provider: Optional[str]
    professional_data_provider: Optional[str]
    tushare_token: str
    tushare_financial_enabled: bool
    official_announcement_provider: Optional[str]
    quant_db_path: Optional[str]
    market_request_timeout: float
    redis_url: Optional[str]
    market_cache_path: Optional[str]
    database_url: Optional[str]
    model_base_url: str
    model_api_key: str
    model_name: str
    model_timeout: float
    router_model_base_url: str
    router_model_api_key: str
    router_model_name: str
    router_model_timeout: float
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
            professional_data_provider=(
                os.getenv("PROFESSIONAL_DATA_PROVIDER")
                or ("tushare" if os.getenv("TUSHARE_TOKEN") else "")
                or None
            ),
            tushare_token=os.getenv("TUSHARE_TOKEN", ""),
            tushare_financial_enabled=_bool(os.getenv("TUSHARE_FINANCIAL_ENABLED", "false")),
            official_announcement_provider=(
                os.getenv("OFFICIAL_ANNOUNCEMENT_PROVIDER", "cninfo") or None
            ),
            quant_db_path=os.getenv("QUANT_DB_PATH") or None,
            market_request_timeout=float(os.getenv("MARKET_REQUEST_TIMEOUT", "8")),
            redis_url=os.getenv("REDIS_URL") or None,
            market_cache_path=os.getenv("MARKET_CACHE_PATH") or None,
            database_url=os.getenv("DATABASE_URL") or None,
            model_base_url=os.getenv(
                "MODEL_BASE_URL",
                "https://ark.cn-beijing.volces.com/api/v3",
            ).rstrip("/"),
            model_api_key=os.getenv("MODEL_API_KEY", ""),
            model_name=os.getenv("MODEL_NAME", ""),
            model_timeout=float(os.getenv("MODEL_TIMEOUT", "60")),
            router_model_base_url=os.getenv(
                "ROUTER_MODEL_BASE_URL",
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
            ).rstrip("/"),
            router_model_api_key=(
                os.getenv("ROUTER_MODEL_API_KEY")
                or os.getenv("DASHSCOPE_API_KEY", "")
            ),
            router_model_name=os.getenv("ROUTER_MODEL_NAME", "qwen3.7-max"),
            router_model_timeout=float(os.getenv("ROUTER_MODEL_TIMEOUT", "5")),
            rate_limit_per_minute=max(1, int(os.getenv("RATE_LIMIT_PER_MINUTE", "30"))),
        )


settings = Settings.from_env()
