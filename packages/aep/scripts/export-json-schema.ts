/**
 * Exports the AEP schema as JSON Schema for non-TypeScript consumers.
 *
 * The source of truth is the runtime Zod model (`src/types.ts`) — it is what
 * `AEPEmitter` validates emitted records against, so the export must be
 * regenerated whenever the model changes. The on-disk file has drifted before
 * (it stayed at aep/v0.3 after the v0.4 wave shipped), so `--check` mode
 * exists for CI: it regenerates in memory and exits non-zero if the file on
 * disk is stale.
 *
 * Usage:
 *   bun run scripts/export-json-schema.ts           # write the file
 *   bun run scripts/export-json-schema.ts --check   # verify it is fresh
 *   # or via npm scripts:
 *   bun run schema:export
 *   bun run schema:check
 *
 * Output: schemas/aep-record.schema.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AEPRecordSchema } from "../src/types.js";

const outputPath = resolve(
  dirname(import.meta.dirname ?? __dirname),
  "schemas",
  "aep-record.schema.json"
);

const check = process.argv.includes("--check");

const jsonSchema = zodToJsonSchema(AEPRecordSchema, {
  name: "AEPRecord",
  $refStrategy: "none",
});

const rendered = JSON.stringify(jsonSchema, null, 2) + "\n";

if (check) {
  const onDisk = readFileSync(outputPath, "utf8");
  if (onDisk !== rendered) {
    console.error(
      `Stale schema export: ${outputPath} does not match the current AEPRecordSchema.\n` +
        "Run `bun run schema:export` in packages/aep and commit the result."
    );
    process.exit(1);
  }
  console.log(`Schema export is up to date: ${outputPath}`);
  process.exit(0);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rendered);

console.log(`JSON Schema written to: ${outputPath}`);
