#!/usr/bin/env bash
# Serve the iPhone mockup generator locally and open it.
# Usage: ./start.sh [port]   (default 8001)

cd "$(dirname "$0")" || exit 1
PORT="${1:-8001}"
URL="http://localhost:${PORT}"

if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else echo "Python 3 is required."; exit 1; fi

if lsof -ti tcp:"${PORT}" >/dev/null 2>&1; then
  echo "Port ${PORT} busy — stopping the old server…"
  lsof -ti tcp:"${PORT}" | xargs kill 2>/dev/null
  sleep 1
fi

echo "iPhone Mockup Generator → ${URL}"
"${PY}" server.py "${PORT}" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'echo; kill ${SERVER_PID} 2>/dev/null; exit 0' INT TERM

for _ in $(seq 1 20); do
  curl -s -o /dev/null "${URL}" && break
  sleep 0.25
done

if command -v open >/dev/null 2>&1; then open "${URL}"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "${URL}"; fi

echo "Server running. Press Ctrl+C to stop."
wait ${SERVER_PID}
