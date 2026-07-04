/**
 * Exports the AEP schema as JSON Schema for non-TypeScript consumers.
 *
 * Usage:
 *   bun run scripts/export-json-schema.ts
 *   # or via npm script:
 *   bun run schema:export
 *
 * Output: schemas/aep-record.schema.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AEPRecordSchema } from "../src/types.js";

const outputPath = resolve(
  dirname(import.meta.dirname ?? __dirname),
  "schemas",
  "aep-record.schema.json"
);

mkdirSync(dirname(outputPath), { recursive: true });

const jsonSchema = zodToJsonSchema(AEPRecordSchema, {
  name: "AEPRecord",
  $refStrategy: "none",
});

writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2) + "\n");

console.log(`JSON Schema written to: ${outputPath}`);
