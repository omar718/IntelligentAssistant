from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.core.security import decode_access_token
from app.models.user import User
from app.services.user_service import get_user_by_id, update_session_activity

bearer_scheme = HTTPBearer(auto_error=False)

_401 = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Invalid or expired token",
    headers={"WWW-Authenticate": "Bearer"},
)
_403_admin = HTTPException(
    status_code=status.HTTP_403_FORBIDDEN,
    detail="Admin access required",
)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Validate the Bearer JWT and return the authenticated User.
    Raises 401 if missing, invalid, or expired.
    """
    if credentials is None:
        raise _401

    try:
        payload = decode_access_token(credentials.credentials)
    except JWTError:
        raise _401

    user_id: str = payload.get("sub")
    if not user_id:
        raise _401

    session_id: str | None = payload.get("sid")

    user = await get_user_by_id(db, user_id)
    if user is None or not user.is_active:
        raise _401

    if session_id:
        session_ok = await update_session_activity(db, user.id, session_id)
        if not session_ok:
            raise _401
    request.state.current_session_id = session_id

    return user


async def require_admin(
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    """Additional guard: require role == 'admin'."""
    role_value = current_user.role.value if hasattr(current_user.role, "value") else current_user.role
    if str(role_value).lower() != "admin":
        if settings.DEBUG:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Admin access required (current role: {role_value})",
            )
        raise _403_admin
    return current_user


CurrentUser = Annotated[User, Depends(get_current_user)]
AdminUser = Annotated[User, Depends(require_admin)]