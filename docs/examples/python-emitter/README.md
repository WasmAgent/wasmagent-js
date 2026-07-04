# Python AEP Emitter Example

Demonstrates emitting AEP (Agent Evidence Protocol) records from Python
using the exported JSON Schema for validation.

## Prerequisites

1. Export the JSON Schema from the TypeScript package:
   ```bash
   cd packages/aep
   bun run schema:export
   ```

2. Install Python dependencies:
   ```bash
   pip install jsonschema
   ```

## Usage

```bash
python emit_record.py
```

This will:
1. Load the JSON Schema from `packages/aep/schemas/aep-record.schema.json`
2. Create a sample AEP record with one action
3. Validate it against the schema
4. Print the validated record as JSON

## Integration

Use `emit_aep_record()` as a starting point for your own Python-based
agent instrumentation. The JSON Schema ensures your records are compatible
with the TypeScript AEP tooling without requiring a TypeScript runtime.
