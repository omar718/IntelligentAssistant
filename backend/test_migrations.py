#!/usr/bin/env python
"""Test script to verify database connection and run migrations."""

import os
import sys
from sqlalchemy import create_engine, text
from alembic.config import Config
from alembic import command

# Set up database URL
db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/intelligent_assistant")
print(f"Using DATABASE_URL: {db_url}")

# Test connection
try:
    engine = create_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(text("SELECT 1"))
        print("✓ Database connection successful")
except Exception as e:
    print(f"✗ Database connection failed: {e}")
    sys.exit(1)

# Run migrations
try:
    alembic_cfg = Config("alembic.ini")
    alembic_cfg.set_main_option("sqlalchemy.url", db_url)

    print("Running migrations...")
    command.upgrade(alembic_cfg, "head")
    print("✓ Migrations completed")
except Exception as e:
    print(f"✗ Migration failed: {e}")
    sys.exit(1)

# Verify tables exist
try:
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
        """))
        tables = [row[0] for row in result]
        print(f"✓ Tables created: {tables}")
except Exception as e:
    print(f"✗ Failed to list tables: {e}")
    sys.exit(1)
