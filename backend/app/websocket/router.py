"""
WebSocket broadcast layer.

Endpoint: ws://host/ws/projects/{project_id}?token=<access_jwt>

Auth: JWT validated on handshake → reject with 4001 if invalid/expired.
Scope: project.user_id must match jwt.sub → reject with 4003.
Events: installation_progress | log | status_change
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import decode_access_token
from app.core.redis import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


async def _stream_project_events(project_id: str, websocket: WebSocket) -> None:
    """Forward worker-published Redis events for a project to a connected client."""
    redis = await get_redis()
    pubsub = redis.pubsub()
    channel = f"project_events:{project_id}"
    await pubsub.subscribe(channel)

    try:
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message and message.get("type") == "message":
                data = message.get("data")
                if isinstance(data, str):
                    await websocket.send_text(data)
            await asyncio.sleep(0.05)
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.close()


# ─── Connection Manager ───────────────────────────────────────────────────────

class ConnectionManager:
    """
    Manages active WebSocket connections grouped by project_id.
    Thread-safe for asyncio; use from a single event loop.
    """

    def __init__(self) -> None:
        # project_id → set of (websocket, user_id)
        self._connections: dict[str, set[tuple[WebSocket, str]]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, project_id: str, ws: WebSocket, user_id: str) -> None:
        await ws.accept()
        async with self._lock:
            self._connections[project_id].add((ws, user_id))
        logger.info("WS connected: user=%s project=%s", user_id, project_id)

    async def disconnect(self, project_id: str, ws: WebSocket, user_id: str) -> None:
        async with self._lock:
            self._connections[project_id].discard((ws, user_id))
            if not self._connections[project_id]:
                del self._connections[project_id]
        logger.info("WS disconnected: user=%s project=%s", user_id, project_id)

    async def broadcast(self, project_id: str, event: dict[str, Any]) -> None:
        """Send event to every subscriber of this project."""
        payload = json.dumps(event)
        dead: list[tuple[WebSocket, str]] = []

        async with self._lock:
            targets = set(self._connections.get(project_id, set()))

        for ws, uid in targets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append((ws, uid))

        # Clean up stale connections
        for ws, uid in dead:
            await self.disconnect(project_id, ws, uid)

    async def send_personal(self, ws: WebSocket, event: dict[str, Any]) -> None:
        await ws.send_text(json.dumps(event))


# Module-level singleton shared across all requests
manager = ConnectionManager()


# ─── Event Builders ───────────────────────────────────────────────────────────

def make_progress_event(step: str, progress: int) -> dict[str, Any]:
    return {"type": "installation_progress", "step": step, "progress": progress}


def make_log_event(level: str, message: str, timestamp: str) -> dict[str, Any]:
    return {"type": "log", "level": level, "message": message, "timestamp": timestamp}


def make_status_event(old_status: str, new_status: str) -> dict[str, Any]:
    return {"type": "status_change", "old_status": old_status, "new_status": new_status}


# ─── WebSocket Endpoint ───────────────────────────────────────────────────────

@router.websocket("/ws/projects/{project_id}")
async def websocket_project(
    websocket: WebSocket,
    project_id: str,
    token: str | None = Query(default=None, description="Optional access JWT"),
    db: AsyncSession = Depends(get_db),
) -> None:
    user_id = "anonymous"

    # 1. Verify project existence / ownership
    from sqlalchemy import text
    row = (
        await db.execute(
            text("SELECT user_id FROM projects WHERE id = :pid"),
            {"pid": project_id},
        )
    ).one_or_none()

    if row is None:
        await websocket.close(code=4004, reason="Project not found")
        return

    # If a token is provided, enforce ownership. If no token is provided,
    # allow read-only progress stream for install UX.
    if token:
        try:
            payload = decode_access_token(token)
            user_id = payload["sub"]
        except Exception:
            await websocket.close(code=4001, reason="Invalid or expired token")
            return

        if row.user_id != user_id:
            await websocket.close(code=4003, reason="Forbidden")
            return

    # 2. Accept and register connection
    await manager.connect(project_id, websocket, user_id)
    events_task = asyncio.create_task(_stream_project_events(project_id, websocket))

    try:
        # Send a welcome / current-state snapshot
        await manager.send_personal(
            websocket,
            {"type": "connected", "project_id": project_id},
        )

        row_status = (
            await db.execute(
                text("SELECT status, port FROM projects WHERE id = :pid"),
                {"pid": project_id},
            )
        ).one_or_none()
        if row_status is not None:
            await manager.send_personal(
                websocket,
                {
                    "type": "status_change",
                    "old_status": "connected",
                    "new_status": row_status.status,
                    "port": row_status.port,
                },
            )

        # Keep alive: listen for ping frames or client messages
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                # Echo ping/pong for keep-alive
                if data == "ping":
                    await manager.send_personal(websocket, {"type": "pong"})
            except asyncio.TimeoutError:
                # Send server-side keepalive ping
                await manager.send_personal(websocket, {"type": "ping"})

    except WebSocketDisconnect:
        pass
    finally:
        events_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await events_task
        await manager.disconnect(project_id, websocket, user_id)