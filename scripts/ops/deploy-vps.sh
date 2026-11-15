#!/usr/bin/env bash
# Deploy the committed HEAD to our own server (garuda.markets on 31.97.72.65): web app + API/worker.
#   SSH_KEY=~/.ssh/clash_hostinger_ed25519 scripts/ops/deploy-vps.sh
# Server layout: code in /opt/garuda (secrets in /opt/garuda/.env and /opt/garuda/.keys, never overwritten here),
# pm2 app "garuda-api" (127.0.0.1:4500), nginx serves /var/www/garuda.markets and proxies /api to the API.
set -euo pipefail
HOST="${DEPLOY_HOST:-root@31.97.72.65}"
KEY="${SSH_KEY:-$HOME/.ssh/clash_hostinger_ed25519}"
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$HOST")
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "commit or stash your changes first: this deploys HEAD" >&2; exit 1; fi
echo "deploying $(git log --oneline -1)"

# 1. web app: built here with the production settings (same-origin /api, wallet sign-in)
OUT="$(mktemp -d)"
# VITE_API_URL stays unset: the app defaults to same-origin /api. (Setting it to "/api" from Git Bash on Windows
# gets rewritten into C:/Program Files/Git/api by MSYS path conversion.)
(cd packages/web && env -u VITE_API_URL node node_modules/vite/bin/vite.js build --outDir "$OUT" --emptyOutDir >/dev/null)
if grep -rq "Program Files" "$OUT/assets"; then echo "build has a Windows path baked in, aborting" >&2; exit 1; fi
tar czf - -C "$OUT" . | "${SSH[@]}" 'set -e; rm -rf /var/www/garuda.markets.new; mkdir -p /var/www/garuda.markets.new
  tar xzf - -C /var/www/garuda.markets.new; chown -R www-data:www-data /var/www/garuda.markets.new
  rm -rf /var/www/garuda.markets.old; mv /var/www/garuda.markets /var/www/garuda.markets.old; mv /var/www/garuda.markets.new /var/www/garuda.markets'
rm -rf "$OUT"
echo "web: deployed"

# 2. API + worker: code only (.env and .keys stay), install, restart; migrations run at startup
git archive --format=tar HEAD | gzip | "${SSH[@]}" 'set -e; cd /opt/garuda; tar xzf -
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10.34.6 install --frozen-lockfile >/dev/null
  pm2 restart garuda-api >/dev/null; sleep 8; curl -fsS 127.0.0.1:4500/health >/dev/null && echo "api: healthy"'
