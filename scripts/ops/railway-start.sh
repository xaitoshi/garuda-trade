#!/bin/sh
# Railway entrypoint. The platform keypair arrives as GARUDA_KEYPAIR_JSON (a secret variable) and is written to a
# private file because the server reads GARUDA_KEYPAIR_PATH. Migrations run inside openDb() at startup.
set -e
if [ -n "$GARUDA_KEYPAIR_JSON" ]; then
  umask 077; mkdir -p /tmp/keys
  printf '%s' "$GARUDA_KEYPAIR_JSON" > /tmp/keys/platform.json
  export GARUDA_KEYPAIR_PATH=/tmp/keys/platform.json
  unset GARUDA_KEYPAIR_JSON
fi
exec pnpm api
