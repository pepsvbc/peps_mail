#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dev_port=${FRONTEND_DEV_PORT:-3001}

if [ ! -f "$project_dir/.env" ]; then
  printf 'Create .env from .env.example and configure your mail servers first.\n' >&2
  exit 1
fi

# Serve the built frontend and API together using the existing application.
export ENVIRONMENT=development
export BASE_PATH=

printf 'Building the app, then serving it at http://localhost:%s\n' "$dev_port"
printf 'No instant reload: stop and rerun this script after editing source files.\n'

# Docker's init forwards Ctrl+C to the app, allowing --rm to clean up.
exec docker compose \
  --project-name peps-mail-dev \
  --env-file "$project_dir/.env" \
  -f "$project_dir/docker-compose.yml" \
  -f - \
  run --rm --build -T --interactive=false \
  -p "127.0.0.1:${dev_port}:3001" \
  app <<'COMPOSE'
services:
  app:
    init: true
COMPOSE
