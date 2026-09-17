/**
 * Release workflow contract regression (2026-09-17, post-#465/#466).
 *
 * Locks the provenance-ownership invariants that two incident fixes landed in
 * .github/workflows/release.yml, so a future YAML refactor cannot silently
 * delete them:
 *
 *   1. the candidate snapshot runs BEFORE the changesets publish step
 *   2. the provenance generator is invoked with --candidates (ownership is
 *      enforced, never self-discovered)
 *   3. the provenance output path is NON-hidden (upload-artifact v4 skips
 *      dot-directories unless include-hidden-files is set)
 *   4. the upload path matches the generator output path
 *   5. the upload sets if-no-files-found: error (fail closed)
 *
 * Deliberately a text/line-level contract, not a general workflow parser.
 *
 * Run: bun test scripts/release-workflow-contract.test.mjs
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
  "utf8",
);

function lineIndex(pattern) {
  const lines = workflow.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

describe("release workflow provenance contract", () => {
  it("snapshot runs before the changesets publish step", () => {
    const snapshot = lineIndex(/Snapshot publish candidates/);
    const publish = lineIndex(/uses: changesets\/action@/);
    expect(snapshot).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(publish);
  });

  it("snapshot step writes the candidates file into release-provenance/", () => {
    const snapshot = lineIndex(/Snapshot publish candidates/);
    const line = workflow.split(/\r?\n/).slice(snapshot, snapshot + 4).join("\n");
    expect(line).toMatch(/node scripts\/snapshot-release-candidates\.mjs --out release-provenance\/candidates\.json/);
  });

  it("generator requires the --candidates snapshot (no self-discovered published set)", () => {
    const emit = lineIndex(/generate-release-provenance\.mjs/);
    expect(emit).toBeGreaterThan(-1);
    const line = workflow.split(/\r?\n/).slice(emit, emit + 4).join("\n");
    expect(line).toMatch(/--candidates release-provenance\/candidates\.json/);
    // The generator itself refuses to run without --candidates.
    const generator = readFileSync(
      join(import.meta.dir, "generate-release-provenance.mjs"),
      "utf8",
    );
    expect(generator).toMatch(/--candidates <snapshot-file> is required/);
  });

  it("provenance paths are non-hidden everywhere (no dot-directory output)", () => {
    expect(workflow).not.toMatch(/\.release-provenance/);
    const generator = readFileSync(
      join(import.meta.dir, "generate-release-provenance.mjs"),
      "utf8",
    );
    expect(generator).not.toMatch(/\.release-provenance/);
  });

  it("upload path matches the generator output path and fails closed on missing files", () => {
    const upload = lineIndex(/name: release-provenance/);
    expect(upload).toBeGreaterThan(-1);
    const lines = workflow.split(/\r?\n/).slice(upload, upload + 4).join("\n");
    expect(lines).toMatch(/path: release-provenance\//);
    expect(lines).toMatch(/if-no-files-found: error/);
  });
});
