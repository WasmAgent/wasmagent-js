#!/usr/bin/env python3
"""
Minimal Python AEP record emitter.

Demonstrates how to emit a valid AEP record using the exported JSON Schema
(schemas/aep-record.schema.json) for validation without requiring TypeScript.

Requirements:
    pip install jsonschema

Usage:
    python python_emitter.py
"""

import json
import time
import uuid
from pathlib import Path

# Optional: validate against the exported JSON Schema
try:
    import jsonschema

    SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "aep-record.schema.json"
    if SCHEMA_PATH.exists():
        with open(SCHEMA_PATH) as f:
            AEP_SCHEMA = json.load(f)
    else:
        AEP_SCHEMA = None
        print(f"Warning: schema not found at {SCHEMA_PATH}, skipping validation")
except ImportError:
    AEP_SCHEMA = None
    print("Warning: jsonschema not installed, skipping validation")


def emit_aep_record(
    run_id: str,
    tool_name: str,
    state_changing: bool,
    *,
    user_id: str | None = None,
    subject_id: str | None = None,
    session_id: str | None = None,
    turn_index: int | None = None,
    model_id: str | None = None,
) -> dict:
    """Build a minimal valid AEP record (unsigned placeholder)."""
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
                "action_id": f"action-0",
                "tool_name": tool_name,
                "state_changing": state_changing,
                "evidence_refs": [],
                "timestamp_ms": now_ms,
            }
        ],
        "verifier_results": [],
        "signature": {
            "alg": "ed25519",
            "key_id": "python-emitter",
            "sig": "UNSIGNED_PLACEHOLDER",
        },
    }

    # Optional fields
    if user_id is not None:
        record["user_id"] = user_id
    if subject_id is not None:
        record["subject_id"] = subject_id
    if model_id is not None:
        record["model_id"] = model_id

    # Run context with session fields
    if session_id is not None or turn_index is not None:
        run_context = {}
        if session_id is not None:
            run_context["session_id"] = session_id
        if turn_index is not None:
            run_context["turn_index"] = turn_index
        record["run_context"] = run_context

    # Validate against JSON Schema if available
    if AEP_SCHEMA is not None:
        jsonschema.validate(record, AEP_SCHEMA)

    return record


if __name__ == "__main__":
    record = emit_aep_record(
        run_id=f"run-py-{uuid.uuid4().hex[:8]}",
        tool_name="write_file",
        state_changing=True,
        user_id="user-alice",
        session_id="session-001",
        turn_index=0,
        model_id="gpt-4o",
    )
    print(json.dumps(record, indent=2))
