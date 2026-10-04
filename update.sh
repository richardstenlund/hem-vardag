#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose exec -T db sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "before-update-$(date +%Y-%m-%d-%H%M%S).dump"
git pull --ff-only
docker compose up -d --build
docker compose ps
