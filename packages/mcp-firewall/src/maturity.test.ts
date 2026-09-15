import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const metadataPath = path.join(import.meta.dir, "../package-metadata.json");
const readmePath = path.join(import.meta.dir, "../README.md");
const indexPath = path.join(import.meta.dir, "index.ts");
const docsPackagesPath = path.join(import.meta.dir, "../../../docs/packages.md");

const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
  maturity: string;
};

describe("maturity consistency", () => {
  test("FW-MAT-01: README maturity matches package-metadata.json", () => {
    const readme = readFileSync(readmePath, "utf8");
    const maturityLabel = metadata.maturity;
    // README uses "Maturity: <value>" pattern (case-insensitive match)
    const pattern = new RegExp(`maturity:\\s*${maturityLabel}`, "i");
    expect(pattern.test(readme)).toBe(true);
  });

  test("FW-MAT-02: src/index.ts header maturity matches package-metadata.json", () => {
    const source = readFileSync(indexPath, "utf8");
    const maturityLabel = metadata.maturity;
    // Header comment uses "@wasmagent/mcp-firewall — <value>"
    const pattern = new RegExp(`@wasmagent/mcp-firewall\\s*—\\s*${maturityLabel}`);
    expect(pattern.test(source)).toBe(true);
  });

  test.todo("FW-MAT-03: docs/packages.md maturity matches package-metadata.json — skip: external doc path fragile across forks", () => {
    const docs = readFileSync(docsPackagesPath, "utf8");
    const maturityLabel = metadata.maturity;
    const pattern = new RegExp(`@wasmagent/mcp-firewall.*\\*\\*${maturityLabel}\\*\\*`, "i");
    expect(pattern.test(docs)).toBe(true);
  });

  test("FW-MAT-04: README does not claim 'stable' when metadata maturity is not stable", () => {
    if (metadata.maturity === "stable") return;
    const readme = readFileSync(readmePath, "utf8");
    // "stable" must not appear as the maturity claim; generic uses like "API stable" are
    // acceptable but claiming the package itself is "stable" tier would be misleading.
    // We check the structured maturity marker only, not free prose.
    const structuredStableClaim = /maturity:\s*stable/i;
    expect(structuredStableClaim.test(readme)).toBe(false);
  });
});
