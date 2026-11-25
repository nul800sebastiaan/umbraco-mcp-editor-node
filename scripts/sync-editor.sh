#!/usr/bin/env bash
# Fetch the upstream Umbraco Editor MCP source into ./editor at a pinned ref, align the
# dependencies that differ between Umbraco majors (mcp-dev, zod) with that ref, and install
# using a lockfile kept per major (locks/package-lock.v<major>.json).
#
#   EDITOR_MCP_REF=v18.0.2   -> Umbraco 18   (default)
#   EDITOR_MCP_REF=v17.6.2   -> Umbraco 17
#
# The Editor MCP major must match the Umbraco major of the site it talks to. Separate
# lockfiles matter: a lock resolved for one major can leave a second copy of zod installed
# for the other, which breaks tool schema conversion.
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${EDITOR_MCP_REF:-v18.0.2}"
REPO="${EDITOR_MCP_REPO:-https://github.com/umbraco/Umbraco-CMS-MCP-Editor}"
rm -rf editor
git clone --quiet --depth 1 --branch "$REF" "$REPO" editor 2>/dev/null
rm -rf editor/.git

MAJOR="$(node -p "require('./editor/package.json').version.split('.')[0]")"
LOCK="locks/package-lock.v${MAJOR}.json"

for dep in @umbraco-cms/mcp-dev zod; do
  version="$(node -p "require('./editor/package.json').dependencies['$dep']")"
  npm pkg set "dependencies.$dep=$version" >/dev/null
done

mkdir -p locks
if [ -f "$LOCK" ]; then cp "$LOCK" package-lock.json; else rm -f package-lock.json; fi
rm -rf node_modules
npm install --ignore-scripts --no-audit --no-fund >/dev/null
cp package-lock.json "$LOCK"
echo "Editor MCP $REF synced (Umbraco $MAJOR), mcp-dev $(node -p "require('./node_modules/@umbraco-cms/mcp-dev/package.json').version"), zod $(node -p "require('./node_modules/zod/package.json').version")"
