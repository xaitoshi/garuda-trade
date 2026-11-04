#!/usr/bin/env bash
# Start (or restart) the Garuda test backend on this box: embedded Postgres + API/worker + a Cloudflare quick tunnel.
# Usage: scripts/ops/backend.sh [start|stop|status]     Requires PRIVY_APP_ID / PRIVY_APP_SECRET in the environment.
# Optional env: GARUDA_CORS_ORIGIN (default: Vercel project domains), CLOUDFLARED (default ~/bin/cloudflared).
# The quick tunnel URL CHANGES on every start: after a restart, update VITE_API_URL in Vercel and redeploy the web app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="${GARUDA_RUN_DIR:-/workspace/garuda-data/run}"
CF="${CLOUDFLARED:-$HOME/bin/cloudflared}"
PORT="${PORT:-3000}"
mkdir -p "$RUN"
cd "$ROOT"

stop() {
  for n in api tunnel pg; do
    if [ -f "$RUN/$n.pid" ]; then kill -- "-$(cat "$RUN/$n.pid")" 2>/dev/null || kill "$(cat "$RUN/$n.pid")" 2>/dev/null || true; rm -f "$RUN/$n.pid"; fi
  done
}
status() {
  for n in pg tunnel api; do
    if [ -f "$RUN/$n.pid" ] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then echo "$n: up (pid $(cat "$RUN/$n.pid"))"; else echo "$n: down"; fi
  done
  [ -f "$RUN/tunnel.url" ] && echo "tunnel url: $(cat "$RUN/tunnel.url")" || true
}
start() {
  stop
  : > "$RUN/pg.log"; : > "$RUN/tunnel.log"; : > "$RUN/api.log"; rm -f "$RUN/tunnel.url"
  setsid nohup pnpm exec tsx scripts/ops/pg-server.ts >> "$RUN/pg.log" 2>&1 & echo $! > "$RUN/pg.pid"
  for _ in $(seq 60); do grep -q "ready on" "$RUN/pg.log" && break; sleep 1; done
  grep -q "ready on" "$RUN/pg.log" || { echo "postgres did not start"; tail "$RUN/pg.log"; exit 1; }
  URL="${GARUDA_PUBLIC_URL:-http://localhost:$PORT}"
  if [ "${NO_TUNNEL:-0}" != "1" ] && [ -x "$CF" ]; then
    setsid nohup "$CF" tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" >> "$RUN/tunnel.log" 2>&1 & echo $! > "$RUN/tunnel.pid"
    T=""
    for _ in $(seq 40); do T="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN/tunnel.log" | head -1 || true)"; [ -n "$T" ] && break; sleep 1; done
    if [ -n "$T" ]; then URL="$T"; echo "$URL" > "$RUN/tunnel.url"; else echo "WARNING: tunnel URL not obtained; API is local only"; fi
    sleep 8
    grep -q "Registered tunnel connection" "$RUN/tunnel.log" || echo "WARNING: cloudflared could not register with the Cloudflare edge (egress blocked?), the tunnel URL will answer 530. See $RUN/tunnel.log"
  fi
  KC="$(node -p "require('./.keys/chain.json').collection")"; UM="$(node -p "require('./.keys/chain.json').usdcMint")"
  DATABASE_URL="postgres://garuda:garuda@127.0.0.1:${GARUDA_PG_PORT:-5433}/garuda" \
  GARUDA_CHAIN=devnet GARUDA_KNIGHT_COLLECTION="${GARUDA_KNIGHT_COLLECTION:-$KC}" GARUDA_USDC_MINT="${GARUDA_USDC_MINT:-$UM}" \
  GARUDA_KEYPAIR_PATH=.keys/platform.json GARUDA_PUBLIC_URL="$URL" GARUDA_TRUST_PROXY=1 PORT="$PORT" \
  GARUDA_CORS_ORIGIN="${GARUDA_CORS_ORIGIN:-https://garuda-grok-bot.vercel.app}" \
    setsid nohup pnpm api >> "$RUN/api.log" 2>&1 & echo $! > "$RUN/api.pid"
  for _ in $(seq 90); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
  status
}
case "${1:-status}" in start|restart) start;; stop) stop;; status) status;; *) echo "usage: $0 [start|stop|status]"; exit 2;; esac
