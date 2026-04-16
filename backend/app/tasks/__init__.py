from celery import Celery
import os

celery = Celery(
    "app",
    broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    include=["app.tasks.install"],
)

celery.conf.update(
    task_track_started=True,
    broker_connection_retry_on_startup=True,
)
