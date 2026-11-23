#!/usr/bin/env bash
# Запускає імітацію Telegram, сервер на тимчасовій базі та наскрізні перевірки.
set -e
cd "$(dirname "$0")/.."
DATA=$(mktemp -d)
node tests/mock-telegram.cjs > /dev/null &
MOCK=$!
PORT=4300 DATA_DIR="$DATA" BOT_TOKEN=TEST:TOKEN ADMIN_IDS=111 WEBAPP_URL=http://localhost:4300 \
  TELEGRAM_API_BASE=http://localhost:9933 node --disable-warning=ExperimentalWarning server.mjs > "$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $MOCK $SERVER 2>/dev/null; rm -rf "$DATA"' EXIT
node tests/e2e.cjs
