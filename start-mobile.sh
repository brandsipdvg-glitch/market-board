#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! curl -sf --max-time 2 http://localhost:3000/api/latest >/dev/null 2>&1; then
  echo "Starting dashboard on port 3000..."
  POLL_MS=500 nohup node server.mjs > market-board.log 2>&1 &
  sleep 8
fi

CLOUDFLARED="$(command -v cloudflared || echo /opt/homebrew/opt/cloudflared/bin/cloudflared)"
echo "Starting public tunnel. Open the trycloudflare.com URL shown below on your phone."
echo "Press Ctrl+C to stop the tunnel."
"$CLOUDFLARED" tunnel --url http://localhost:3000 2>&1 | tee /tmp/market-board-tunnel.log
