# tests/test_admin_guard.py
from unittest.mock import patch
from fastapi import status


async def test_regular_user_gets_403(async_client, regular_user, user_token):
    response = await async_client.get(
        "/api/admin/users",
        headers={"Authorization": f"Bearer {user_token}"}
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert response.json()["detail"] == "Admin access required"


async def test_admin_user_gets_200(async_client, admin_user, admin_token):
    response = await async_client.get(
        "/api/admin/users",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == status.HTTP_200_OK


async def test_no_token_gets_401(async_client):
    response = await async_client.get("/api/admin/users")
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


async def test_expired_token_gets_401(async_client, expired_token):
    response = await async_client.get(
        "/api/admin/users",
        headers={"Authorization": f"Bearer {expired_token}"}
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


async def test_deactivated_admin_gets_403(async_client, db_session, admin_user, admin_token):
    # Deactivate the admin mid-test
    admin_user.is_active = False
    db_session.add(admin_user)
    await db_session.commit()

    response = await async_client.get(
        "/api/admin/users",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN