#!/usr/bin/env bash
# run-judge.sh — single entry point for the SWE-bench-lite container judge.
#
# Inside the container we have:
#   - python (3.11+) with pip
#   - git + standard build tools
#   - the official SWE-bench harness installed via pip
#
# Inputs (as files mounted at /work):
#   /work/instance.json    Task descriptor — { instance_id, repo, base_commit,
#                          test_patch, fail_to_pass, pass_to_pass, version,
#                          environment_setup_commit }
#   /work/patch.diff       The agent-produced patch we are judging.
#
# Outputs:
#   /work/result.json      { resolved: boolean, fail_to_pass: {passed:[],failed:[]},
#                            pass_to_pass: {passed:[],failed:[]}, error?: string }
#
# This script is the only thing the container's CMD invokes; the harness
# in swe-bench-lite.mjs's runTests() does:
#
#   docker run --rm -v $tmpDir:/work agentkit-swe-judge:latest
#
# and reads /work/result.json afterward.

set -euo pipefail

INSTANCE_JSON="/work/instance.json"
PATCH_FILE="/work/patch.diff"
RESULT_JSON="/work/result.json"

if [[ ! -f "$INSTANCE_JSON" ]]; then
  echo '{"resolved": false, "error": "missing /work/instance.json"}' > "$RESULT_JSON"
  exit 0
fi
if [[ ! -f "$PATCH_FILE" ]]; then
  echo '{"resolved": false, "error": "missing /work/patch.diff"}' > "$RESULT_JSON"
  exit 0
fi

# Run the python evaluator (judge.py is in the same image at /opt/judge/).
python3 /opt/judge/judge.py \
  --instance "$INSTANCE_JSON" \
  --patch "$PATCH_FILE" \
  --output "$RESULT_JSON" \
  "$@" || {
    # judge.py is responsible for writing a result.json on its own
    # failure paths. This branch only fires if the python entry blows up
    # before it could write anything (e.g. import error).
    if [[ ! -f "$RESULT_JSON" ]]; then
      echo '{"resolved": false, "error": "judge.py exited non-zero before writing result.json"}' > "$RESULT_JSON"
    fi
    exit 0
  }
