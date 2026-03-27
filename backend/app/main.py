from dotenv import load_dotenv
load_dotenv()                          # loads .env (Docker defaults: host=db)
load_dotenv(".env.local", override=True)  # local override: host=localhost
import logging
import time
from typing import Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import projects
from app.api.routes.auth import auth_router
from app.core.config import settings

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("app.main")

app = FastAPI(
    title="Intelligent Assistant API",
    version="0.1.0",
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
)

# ---------------------------------------------------------------------------
# Middlewares
# ---------------------------------------------------------------------------

# Optimized CORS using settings
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.APP_BASE_URL,
        "http://localhost:3000", # Common dev port
        "http://localhost:5173", # Vite dev port
    ],
    allow_credentials=True, # Required for cookies
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_process_time_header(request: Request, call_next: Callable):
    start_time = time.time()
    try:
        response = await call_next(request)
        process_time = time.time() - start_time
        response.headers["X-Process-Time"] = str(process_time)
        return response
    except Exception as e:
        logger.exception("Global unhandled exception in middleware: %s", e)
        return JSONResponse(
            status_code=500,
            content={"detail": "An internal server error occurred. Please try again later."}
        )

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

app.include_router(auth_router, tags=["auth"])
app.include_router(projects.router, tags=["projects"])

@app.get("/health", tags=["health"])
async def health():
    """System health check used for monitoring and local detection."""
    from app.core.redis import get_redis
    from app.core.database import engine
    from sqlalchemy import text
    
    status = {"status": "ok", "db": "unknown", "redis": "unknown"}
    
    try:
        redis = await get_redis()
        await redis.ping()
        status["redis"] = "connected"
    except Exception as e:
        logger.error("Health check Redis failure: %s", e)
        status["redis"] = "error"

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        status["db"] = "connected"
    except Exception as e:
        logger.error("Health check DB failure: %s", e)
        status["db"] = "error"

    return status

