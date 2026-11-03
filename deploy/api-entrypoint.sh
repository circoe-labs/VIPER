#!/bin/sh
# Migrate, (re)provision the SQL console's read-only role, then serve. Any failure stops the
# container: Docker shows it in `docker compose logs api` instead of a silent proxy error.
set -eu

python -m alembic upgrade head
python -m app.cli provision-sql-reader

# Behind Caddy: trust X-Forwarded-For/Proto (login throttle per client IP, https scheme).
# The API port is never published, only Caddy reaches it.
exec python -m uvicorn app.main:create_app --factory \
    --host 0.0.0.0 --port 8000 \
    --proxy-headers --forwarded-allow-ips '*'
