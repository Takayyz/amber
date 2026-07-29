#!/usr/bin/env bash
# One-time R2 setup: creates the bucket, applies the CORS policy, and writes
# R2_ACCOUNT_ID into .dev.vars (not wrangler.jsonc -- this repo is public, and
# an account ID identifies you personally even though it isn't a credential).
# Requires `wrangler login` beforehand.
#
# Usage: CLOUDFLARE_ACCOUNT_ID=xxxxx pnpm setup:r2
#   ALLOWED_ORIGINS can override the default (comma-separated for multiple origins).
#
# NOT covered here (dashboard-only, wrangler cannot create these):
#   R2 > Manage R2 API Tokens > Create API Token (Object Read & Write, scoped to
#   the bucket) -- then add the Access Key ID / Secret Access Key to
#   apps/api/.dev.vars (local) or `wrangler secret put` (production).

set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$API_DIR"

BUCKET_NAME="amber-media"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://localhost:5173}"

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "error: CLOUDFLARE_ACCOUNT_ID is required (Cloudflare dashboard sidebar shows it)." >&2
  echo "usage: CLOUDFLARE_ACCOUNT_ID=xxxxx pnpm setup:r2" >&2
  exit 1
fi

echo "==> Creating R2 bucket: $BUCKET_NAME"
# --update-config=false: don't let wrangler add an r2_buckets binding to
# wrangler.jsonc -- the Worker talks to R2 via presigned S3 URLs (aws4fetch),
# never through a binding, so one would just be unused config.
pnpm exec wrangler r2 bucket create "$BUCKET_NAME" --update-config=false || echo "  (already exists, continuing)"

echo "==> Applying CORS policy for origin(s): $ALLOWED_ORIGINS"
CORS_FILE="$(mktemp)"
trap 'rm -f "$CORS_FILE"' EXIT
ALLOWED_ORIGINS="$ALLOWED_ORIGINS" node -e "
const fs = require('fs');
const origins = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
const cors = {
  rules: [
    {
      allowed: {
        origins,
        methods: ['GET', 'PUT'],
        headers: ['Content-Type'],
      },
      maxAgeSeconds: 3600,
    },
  ],
};
fs.writeFileSync(process.argv[1], JSON.stringify(cors, null, 2));
" "$CORS_FILE"
pnpm exec wrangler r2 bucket cors set "$BUCKET_NAME" --file "$CORS_FILE" --force

echo "==> Writing R2_ACCOUNT_ID into .dev.vars"
DEV_VARS_FILE=".dev.vars"
touch "$DEV_VARS_FILE"
if grep -q '^R2_ACCOUNT_ID=' "$DEV_VARS_FILE"; then
  sed -i.bak "s/^R2_ACCOUNT_ID=.*/R2_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID/" "$DEV_VARS_FILE"
  rm -f "$DEV_VARS_FILE.bak"
else
  echo "R2_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID" >> "$DEV_VARS_FILE"
fi

cat <<'EOF'

Bucket, CORS, and R2_ACCOUNT_ID (in .dev.vars) are set up. One manual step
remains (dashboard-only, wrangler can't create API tokens):

  1. R2 > Manage R2 API Tokens > Create API Token
     (Object Read & Write, scoped to the amber-media bucket)
  2. Add the resulting keys to apps/api/.dev.vars:
       R2_ACCESS_KEY_ID=...
       R2_SECRET_ACCESS_KEY=...
  3. For production, none of R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
     R2_SECRET_ACCESS_KEY live in wrangler.jsonc -- set all three with:
       pnpm exec wrangler secret put R2_ACCOUNT_ID
       pnpm exec wrangler secret put R2_ACCESS_KEY_ID
       pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
EOF
