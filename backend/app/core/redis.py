import json
import time
from typing import Optional, Any, Dict

import redis.asyncio as aioredis

from app.core.config import settings

# ---------------------------------------------------------------------------
# Shared async Redis client
# ---------------------------------------------------------------------------

_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = await aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
        )
    return _redis


# ---------------------------------------------------------------------------
# Task State Management (Redis-backed)
# ---------------------------------------------------------------------------

TASK_STATE_TTL = 3600  # 1 hour

async def set_task_state(task_id: str, state: Dict[str, Any]) -> None:
    """Store task progress/metadata in Redis with a 1-hour TTL."""
    redis = await get_redis()
    key = f"task:state:{task_id}"
    await redis.set(key, json.dumps(state), ex=TASK_STATE_TTL)

async def get_task_state(task_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve task progress/metadata from Redis."""
    redis = await get_redis()
    key = f"task:state:{task_id}"
    data = await redis.get(key)
    if data:
        return json.loads(data)
    return None

async def set_task_cancelled(task_id: str) -> None:
    """Mark a task as cancelled in Redis."""
    redis = await get_redis()
    key = f"task:cancelled:{task_id}"
    await redis.set(key, "1", ex=TASK_STATE_TTL)

async def is_task_cancelled(task_id: str) -> bool:
    """Check if a task has been marked as cancelled."""
    redis = await get_redis()
    key = f"task:cancelled:{task_id}"
    return await redis.exists(key) > 0


# ---------------------------------------------------------------------------
# Redis-backed sliding-window rate limiter
# ---------------------------------------------------------------------------

class RateLimiter:
    """
    Sliding window rate limiter using a sorted set per key.

    Each member of the set is a unique request timestamp (float).
    Members older than `window_seconds` are pruned on every check.
    """

    def __init__(self, max_attempts: int, window_seconds: int):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds

    async def is_allowed(self, identifier: str) -> tuple[bool, int]:
        """
        Check whether the identifier is within its rate limit.

        Args:
            identifier: unique string key, e.g. 'login:1.2.3.4' or 'forgot:user@example.com'

        Returns:
            (allowed: bool, retry_after_seconds: int)
            retry_after_seconds is 0 when allowed.
        """
        redis = await get_redis()
        now = time.time()
        window_start = now - self.window_seconds
        key = f"ratelimit:{identifier}"

        pipe = redis.pipeline()
        # Remove expired entries
        pipe.zremrangebyscore(key, 0, window_start)
        # Count remaining
        pipe.zcard(key)
        # Add current request with timestamp as both score and member
        pipe.zadd(key, {str(now): now})
        # Expire the whole key after one window so Redis cleans up automatically
        pipe.expire(key, self.window_seconds)
        results = await pipe.execute()

        count = results[1]  # after pruning, before adding current request
        if count >= self.max_attempts:
            # Find the oldest entry to compute retry-after
            oldest = await redis.zrange(key, 0, 0, withscores=True)
            if oldest:
                retry_after = int(self.window_seconds - (now - oldest[0][1])) + 1
            else:
                retry_after = self.window_seconds
            return False, retry_after

        return True, 0


# ---------------------------------------------------------------------------
# Pre-configured limiters matching the spec (§2.5)
# ---------------------------------------------------------------------------

login_limiter = RateLimiter(max_attempts=10, window_seconds=900)       # 10 / 15 min / IP
register_limiter = RateLimiter(max_attempts=10, window_seconds=3600)  # 10 / 1 hr / IP
forgot_limiter = RateLimiter(max_attempts=3, window_seconds=3600)     # 3 / 1 hr / email
reset_limiter = RateLimiter(max_attempts=5, window_seconds=3600)      # 5 / 1 hr / token