/**
 * Protocol-matrix consistency gate.
 *
 * The machine-readable protocol matrix (evals/protocol/mcp-protocol-matrix.json)
 * is the authority for MCP protocol-support claims. This gate enforces:
 *   PM-01  matrix parses and declares the pinned schema + tested SHA
 *   PM-02  every row uses only the declared status vocabulary (no green/red)
 *   PM-03  every row carries the full provenance field set
 *   PM-04  every file referenced in test_or_evidence exists in the repo
 *   PM-05  the committed Markdown view is byte-identical to a regeneration
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MATRIX_PATH = join(import.meta.dir, "../evals/protocol/mcp-protocol-matrix.json");
const DOC_PATH = join(
  import.meta.dir,
  "../../../docs/security/mcp-firewall-protocol-conformance.md"
);
const REPO_ROOT = join(import.meta.dir, "../../..");

const REQUIRED_FIELDS = [
  "id",
  "name",
  "status",
  "test_or_evidence",
  "tested_sha",
  "owner_package",
  "claim_ceiling",
  "notes",
] as const;

/** Extract candidate repo-relative file paths from a free-form evidence string. */
function referencedPaths(evidence: string): string[] {
  const out: string[] = [];
  const candidates = evidence.match(/[\w@./-]+\.(?:ts|mts|mjs|js|json|md|yml|yaml)/g) ?? [];
  for (const c of candidates) {
    // A reference may embed an anchor like `file.ts::symbol` — the regex above
    // already stops at ':', so `c` is the bare path.
    out.push(c);
  }
  return out;
}

describe("PM: protocol matrix consistency", () => {
  const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));

  it("PM-01: declares pinned schema and a 40-char tested SHA", () => {
    expect(matrix.$schema).toBe("wasmagent-mcp-protocol-matrix/v1");
    expect(matrix.tested_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Array.isArray(matrix.status_vocabulary)).toBe(true);
  });

  it("PM-02: every row status is inside the declared vocabulary", () => {
    const vocab = new Set<string>(matrix.status_vocabulary);
    let rows = 0;
    for (const rowsOfSection of Object.values(matrix.sections) as Array<
      Array<Record<string, unknown>>
    >) {
      for (const row of rowsOfSection) {
        rows++;
        expect(vocab.has(row.status as string)).toBe(true);
      }
    }
    expect(rows).toBeGreaterThanOrEqual(30);
  });

  it("PM-03: every row carries the full provenance field set", () => {
    for (const rowsOfSection of Object.values(matrix.sections) as Array<
      Array<Record<string, unknown>>
    >) {
      for (const row of rowsOfSection) {
        for (const field of REQUIRED_FIELDS) {
          expect(field in row).toBe(true);
        }
        expect(row.tested_sha).toBe(matrix.tested_sha);
      }
    }
  });

  it("PM-04: every repo file referenced in test_or_evidence exists", () => {
    const missing: string[] = [];
    for (const rowsOfSection of Object.values(matrix.sections) as Array<
      Array<Record<string, unknown>>
    >) {
      for (const row of rowsOfSection) {
        for (const p of referencedPaths(row.test_or_evidence as string)) {
          if (!existsSync(join(REPO_ROOT, p))) missing.push(`${row.id}: ${p}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("PM-05: committed Markdown view is byte-identical to a regeneration", async () => {
    const { renderMatrix } = await import("../evals/protocol/render-protocol-matrix.mjs");
    const expected = renderMatrix(matrix) + "\n";
    const committed = readFileSync(DOC_PATH, "utf8");
    expect(committed).toBe(expected);
  });
});
