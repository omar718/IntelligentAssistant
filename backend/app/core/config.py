from pydantic_settings import BaseSettings
from functools import lru_cache
import os

# Resolve .env relative to this file so it works regardless of cwd
_ENV_FILE = os.path.join(os.path.dirname(__file__), "../../.env")
_ENV_LOCAL_FILE = os.path.join(os.path.dirname(__file__), "../../.env.local")


class Settings(BaseSettings):
    # App
    APP_NAME: str = "Intelligent Assistant"
    DEBUG: bool = False

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://user:password@localhost:5432/intelligent_assistant"

    # Redis
    REDIS_URL: str = "redis://localhost:6379"

    # JWT
    JWT_SECRET_KEY: str  # Must be set in .env
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_TTL_MINUTES: int = 15
    REFRESH_TOKEN_TTL_DAYS: int = 7

    # Email
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = "silverdude47@gmail.com"
    SMTP_PASSWORD: str = "ugmwlxermilmlaak"
    EMAIL_FROM: str = "noreply@intelligent-assistant.dev"

    # App base URL (used for email links)
    APP_BASE_URL: str = "http://localhost:3000"
    API_BASE_URL: str = "http://localhost:8000"

    # Anthropic (server-side only — NEVER sent to clients)
    ANTHROPIC_API_KEY: str = ""

    class Config:
        env_file = (_ENV_FILE, _ENV_LOCAL_FILE)
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()