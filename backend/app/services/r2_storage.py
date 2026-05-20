# app/services/storage.py
import logging
import aioboto3
from botocore.exceptions import ClientError
from app.core.config import settings

logger = logging.getLogger(__name__)


class B2Storage:

    def _client(self):
        session = aioboto3.Session()
        return session.client(
            "s3",
            endpoint_url=settings.B2_ENDPOINT,
            aws_access_key_id=settings.B2_KEY_ID,
            aws_secret_access_key=settings.B2_APPLICATION_KEY,
            region_name=settings.B2_REGION,
        )

    async def upload(self, key: str, data: bytes,
                     content_type: str = "application/pdf") -> str:
        async with self._client() as s3:
            await s3.put_object(
                Bucket=settings.B2_BUCKET,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
        logger.info("B2 upload OK: %s (%d bytes)", key, len(data))
        return key

    async def download(self, key: str) -> bytes:
        try:
            async with self._client() as s3:
                response = await s3.get_object(
                    Bucket=settings.B2_BUCKET, Key=key
                )
                return await response["Body"].read()
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                raise FileNotFoundError(f"B2 object not found: {key}")
            raise

    async def delete(self, key: str) -> None:
        async with self._client() as s3:
            await s3.delete_object(Bucket=settings.B2_BUCKET, Key=key)
        logger.info("B2 delete OK: %s", key)

    async def exists(self, key: str) -> bool:
        try:
            async with self._client() as s3:
                await s3.head_object(Bucket=settings.B2_BUCKET, Key=key)
            return True
        except ClientError:
            return False