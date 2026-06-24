#!/usr/bin/env node
/**
 * check-release-cadence.mjs — CI gate for release cadence policy.
 *
 * Checks: if [Unreleased] in CHANGELOG.md is non-empty (has actual bullet
 * items, not just section headers), the last git tag must be within 14 days.
 *
 * Exit 0 = cadence OK or [Unreleased] is empty.
 * Exit 1 = [Unreleased] is non-empty and last tag is > 14 days ago (stall).
 *
 * Usage:
 *   node scripts/check-release-cadence.mjs            # check only
 *   node scripts/check-release-cadence.mjs --warn-only # exit 0 but print warning
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const warnOnly = process.argv.includes("--warn-only");

// ── 1. Parse [Unreleased] section from CHANGELOG.md ──────────────────────────

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

// Extract text between ## [Unreleased] and the next ## [
const unreleasedMatch = changelog.match(/^## \[Unreleased\]([\s\S]*?)(?=^## \[)/m);
if (!unreleasedMatch) {
  console.log("✓ No [Unreleased] section found — cadence check skipped.");
  process.exit(0);
}

const unreleasedBody = unreleasedMatch[1];

// Count non-empty bullet items (lines starting with "- " that have content)
const bullets = unreleasedBody
  .split("\n")
  .filter((l) => /^[-*]\s+\S/.test(l.trim()));

if (bullets.length === 0) {
  console.log("✓ [Unreleased] is empty — no release pending.");
  process.exit(0);
}

console.log(`[Unreleased] has ${bullets.length} item(s). Checking last tag date...`);

// ── 2. Find last tag date ─────────────────────────────────────────────────────

let lastTagDateMs;
try {
  const tagLine = execSync("git log --tags --simplify-by-decoration --pretty='%ai %D' | grep 'tag:' | head -1", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  if (!tagLine) {
    console.log("✓ No tags found — first release cycle, cadence check skipped.");
    process.exit(0);
  }

  // Format: "2026-06-18 12:00:00 +0800  tag: v0.3.0, ..."
  const dateStr = tagLine.split(/\s+/).slice(0, 2).join(" ");
  lastTagDateMs = new Date(dateStr).getTime();
} catch {
  console.log("✓ Could not determine last tag — cadence check skipped.");
  process.exit(0);
}

// ── 3. Check staleness ───────────────────────────────────────────────────────

const nowMs = new Date().getTime();
const daysSinceTag = Math.floor((nowMs - lastTagDateMs) / (1000 * 60 * 60 * 24));
const STALE_DAYS = 14;

if (daysSinceTag > STALE_DAYS) {
  const msg = `⚠  Release cadence stall: [Unreleased] is non-empty and last tag was ${daysSinceTag} days ago (policy: ≤${STALE_DAYS} days). Add a row to docs/strategy/release-cadence-log.md and tag a release.`;
  if (warnOnly) {
    console.warn(msg);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

console.log(`✓ Release cadence OK: last tag was ${daysSinceTag} day(s) ago (${STALE_DAYS}-day policy).`);
