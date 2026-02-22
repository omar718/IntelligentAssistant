#!/usr/bin/env python
"""
Manual migration script to create database tables.
This is a workaround for Docker/Git bash path issues.
"""

import os
import sys
from sqlalchemy import create_engine, text
from datetime import datetime

# Database connection
db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@db:5432/intelligent_assistant")
engine = create_engine(db_url)

# SQL to create tables
create_tables_sql = """
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50),
    path VARCHAR NOT NULL,
    status VARCHAR(50) DEFAULT 'queued',
    port INTEGER,
    pid INTEGER,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    metadata JSON
);

CREATE TABLE IF NOT EXISTS installation_history (
    id SERIAL PRIMARY KEY,
    project_id VARCHAR(50) REFERENCES projects(id),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    success BOOLEAN,
    steps JSON,
    errors JSON,
    resolution_used VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS error_patterns (
    id SERIAL PRIMARY KEY,
    signature VARCHAR NOT NULL,
    category VARCHAR(50),
    project_type VARCHAR(50),
    solutions JSON,
    occurrences INTEGER DEFAULT 1,
    success_rate FLOAT
);

CREATE TABLE IF NOT EXISTS configuration_templates (
    id SERIAL PRIMARY KEY,
    project_type VARCHAR(50),
    framework VARCHAR(100),
    template JSON,
    success_count INTEGER DEFAULT 0,
    use_count INTEGER DEFAULT 0
);

-- Create alembic_version table
CREATE TABLE IF NOT EXISTS alembic_version (
    version_num VARCHAR(32) PRIMARY KEY
);

-- Insert the current migration version
INSERT INTO alembic_version (version_num) VALUES ('e96d0710fac6')
ON CONFLICT(version_num) DO NOTHING;
"""

try:
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
        print("Database connection successful")

        # Create tables
        for statement in create_tables_sql.split(';'):
            statement = statement.strip()
            if statement:
                conn.execute(text(statement))
                print(f"Executed: {statement[:60]}...")

        conn.commit()
        print("\nAll tables created successfully!")

        # Verify tables exist
        result = conn.execute(text("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        """))
        tables = [row[0] for row in result]
        print(f"Tables in database: {tables}")

except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
