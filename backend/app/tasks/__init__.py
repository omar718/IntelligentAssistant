from celery import Celery
import os

celery = Celery(
    "app",
    broker=os.environ.get("REDIS_URL", "redis://redis:6379"),
    backend=os.environ.get("REDIS_URL", "redis://redis:6379")
)

celery.conf.update(task_track_started=True)
