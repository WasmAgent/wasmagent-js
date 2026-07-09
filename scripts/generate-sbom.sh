#!/usr/bin/env bash
set -euo pipefail
npx @cyclonedx/cyclonedx-npm --output-file sbom.json --spec-version 1.5
