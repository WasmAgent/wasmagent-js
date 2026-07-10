#!/usr/bin/env bash
set -euo pipefail

# CycloneDX npm plugin requires package-lock.json which bun doesn't generate.
# Create a minimal npm lockfile from the workspace before generating the SBOM.
npm install --package-lock-only --ignore-scripts 2>/dev/null || true

npx @cyclonedx/cyclonedx-npm --output-file sbom.json --spec-version 1.5 --ignore-npm-errors
