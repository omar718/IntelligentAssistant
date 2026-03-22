from dotenv import load_dotenv
load_dotenv()                          # loads .env (Docker defaults: host=db)
load_dotenv(".env.local", override=True)  # local override: host=localhost
import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import projects
from app.core.config import settings
from app.api.routes.auth import auth_router



app = FastAPI(
    title="Intelligent Assistant API",
    version="0.1.0",
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,

)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True, #required for cookies
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(auth_router, tags=["auth"])

@app.get("/health")
async def health():
    """Used by the VS Code extension for online/offline detection."""
    from app.core.redis import get_redis
    from app.core.database import engine
    try:
        redis = await get_redis()
        await redis.ping()
        redis_status = "connected"
    except Exception:
        redis_status = "error"

    try:
        async with engine.connect() as conn:
            await conn.execute(__import__("sqlalchemy").text("SELECT 1"))
        db_status = "connected"
    except Exception:
        db_status = "error"

    return {"status": "ok", "db": db_status, "redis": redis_status}

