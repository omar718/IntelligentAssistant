from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User
from app.services.user_service import get_user_by_id

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

    user = await get_user_by_id(db, user_id)
    if user is None or not user.is_active:
        raise _401

    return user


async def require_admin(
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    """Additional guard: require role == 'admin'."""
    if current_user.role != "admin":
        raise _403_admin
    return current_user


CurrentUser = Annotated[User, Depends(get_current_user)]
AdminUser = Annotated[User, Depends(require_admin)]