#!/usr/bin/env bash
#
# install.sh — enable .githooks for this clone.
#
# Run once after cloning:
#   bash .githooks/install.sh
#
# This points `core.hooksPath` at .githooks/ so the pre-push hook fires.
# Idempotent.

set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git config core.hooksPath .githooks
chmod +x .githooks/pre-push

echo "✓ Git hooks installed:"
echo "    core.hooksPath = $(git config --get core.hooksPath)"
echo
echo "  Pre-push will now run:"
echo "    - npx biome check packages/"
echo "    - node scripts/check-no-control-bytes.mjs"
echo "    - node scripts/check-version-coherence.mjs"
echo "    - npm run typecheck"
echo "    - npm run build"
echo "    - bun test (critical subset; set FULL_TEST=1 for all)"
echo "    - node scripts/publish-check.mjs"
echo
echo "  Emergency bypass:  git push --no-verify"
