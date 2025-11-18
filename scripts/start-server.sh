#!/usr/bin/env bash
set -euo pipefail

readonly DEFAULT_PORT=3004

secret_value() {
  local secret_name="$1"
  if ! command -v gcloud >/dev/null 2>&1; then
    return 1
  fi
  local value
  if ! value=$(gcloud secrets versions access latest --secret="$secret_name" 2>/dev/null); then
    return 1
  fi
  printf '%s' "$value" | tr -d '\n'
}

populate_env_if_missing() {
  local var_name="$1"
  local secret_name="${2:-$var_name}"
  if [ -n "${!var_name:-}" ]; then
    return
  fi
  if value=$(secret_value "$secret_name"); then
    if [ -n "$value" ]; then
      export "$var_name"="$value"
    fi
  fi
}

populate_env_if_missing YOUTUBE_API_KEY
populate_env_if_missing FIREBASE_API_KEY
populate_env_if_missing FIREBASE_AUTH_DOMAIN
populate_env_if_missing FIREBASE_PROJECT_ID
populate_env_if_missing FIREBASE_STORAGE_BUCKET
populate_env_if_missing FIREBASE_MESSAGING_SENDER_ID
populate_env_if_missing FIREBASE_APP_ID
populate_env_if_missing FIREBASE_MEASUREMENT_ID

export PORT="${PORT:-$DEFAULT_PORT}"

exec node backend/server.js
