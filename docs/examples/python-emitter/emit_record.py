"""
Minimal Python emitter example for AEP (Agent Evidence Protocol).

This demonstrates how to emit AEP records in Python using the canonical
JSON Schema from @wasmagent/protocol for validation, without needing
the TypeScript runtime.

Requirements:
    pip install jsonschema
    bun install   # ensures @wasmagent/protocol is available

Usage:
    python emit_record.py
"""

import json
import time
import uuid
from pathlib import Path

try:
    from jsonschema import validate, ValidationError
except ImportError:
    print("Install jsonschema: pip install jsonschema")
    raise SystemExit(1)

# Load the canonical JSON Schema from @wasmagent/protocol
# (single source of truth — see WasmAgent/wasmagent-protocol)
SCHEMA_PATH = (
    Path(__file__).resolve().parents[3]
    / "node_modules"
    / "@wasmagent"
    / "protocol"
    / "schemas"
    / "aep"
    / "aep-record.schema.json"
)

if not SCHEMA_PATH.exists():
    print(f"Canonical schema not found at {SCHEMA_PATH}")
    print("Run 'bun install' from the repo root to install @wasmagent/protocol.")
    raise SystemExit(1)

with open(SCHEMA_PATH) as f:
    schema = json.load(f)


def emit_aep_record(
    run_id: str,
    tool_name: str,
    state_changing: bool = False,
) -> dict:
    """Create and validate an AEP record against the canonical schema."""
    now_ms = int(time.time() * 1000)

    record = {
        "schema_version": "aep/v0.2",
        "run_id": run_id,
        "created_at_ms": now_ms,
        "input_refs": [],
        "output_refs": [],
        "capability_decisions": [],
        "actions": [
            {
                "action_id": f"action-{uuid.uuid4().hex[:8]}",
                "tool_name": tool_name,
                "state_changing": state_changing,
                "timestamp_ms": now_ms,
                "evidence_refs": [],
            }
        ],
        "verifier_results": [],
        "signature": {
            "alg": "ed25519",
            "key_id": "python-emitter",
            "sig": "UNSIGNED_PLACEHOLDER",
        },
    }

    # Validate against the canonical JSON Schema from @wasmagent/protocol
    validate(instance=record, schema=schema)

    return record


if __name__ == "__main__":
    record = emit_aep_record(
        run_id=f"run-py-{uuid.uuid4().hex[:8]}",
        tool_name="python_example",
        state_changing=False,
    )
    print(json.dumps(record, indent=2))
    print("\nAEP record validated successfully against canonical schema.")
