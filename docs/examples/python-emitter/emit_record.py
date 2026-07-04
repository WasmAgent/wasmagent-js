"""
Minimal Python emitter example for AEP (Agent Evidence Protocol).

This demonstrates how to emit AEP records in Python using the exported
JSON Schema for validation, without needing the TypeScript runtime.

Requirements:
    pip install jsonschema

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

# Load the exported JSON Schema
SCHEMA_PATH = Path(__file__).resolve().parents[3] / "packages" / "aep" / "schemas" / "aep-record.schema.json"

if not SCHEMA_PATH.exists():
    print(f"Schema not found at {SCHEMA_PATH}")
    print("Run 'bun run schema:export' in packages/aep first.")
    raise SystemExit(1)

with open(SCHEMA_PATH) as f:
    schema = json.load(f)


def emit_aep_record(
    run_id: str,
    tool_name: str,
    state_changing: bool = False,
    user_id: str | None = None,
    subject_id: str | None = None,
) -> dict:
    """Create and validate an AEP record."""
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

    # Add optional identity fields
    if user_id is not None:
        record["user_id"] = user_id
    if subject_id is not None:
        record["subject_id"] = subject_id

    # Validate against the JSON Schema
    # Note: the schema is wrapped in a top-level object by zod-to-json-schema;
    # the actual schema definition may be under a key like "definitions" or directly.
    schema_def = schema.get("definitions", {}).get("AEPRecord", schema)
    validate(instance=record, schema=schema_def)

    return record


if __name__ == "__main__":
    record = emit_aep_record(
        run_id=f"run-py-{uuid.uuid4().hex[:8]}",
        tool_name="python_example",
        state_changing=False,
        user_id="user-alice",
        subject_id="subject-project-x",
    )
    print(json.dumps(record, indent=2))
    print("\nAEP record validated successfully against JSON Schema.")
