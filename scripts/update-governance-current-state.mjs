#!/usr/bin/env node
/**
 * update-governance-current-state.mjs — refresh the "Last refreshed" date
 * and the npm-latest row of GOVERNANCE.md's "Current state" table after a
 * tagged release (#243). Invoked by .github/workflows/release.yml when
 * packages were published; commits the change with [skip ci] so it does not
 * re-trigger the release workflow.
 *
 * No side effects when the date row is already current (idempotent).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const file = "GOVERNANCE.md";
const today = new Date().toISOString().slice(0, 10);
let text = readFileSync(file, "utf8");
const before = text;

text = text.replace(
  /> Last refreshed: \*\*\d{4}-\d{2}-\d{2}\*\*\./,
  `> Last refreshed: **${today}**.`
);
text = text.replace(
  /## Current state \(updated \d{4}-\d{2}-\d{2}\)/,
  `## Current state (updated ${today})`
);

// Refresh the npm-latest row when a core version is supplied.
const coreVersion = process.argv[2];
if (coreVersion) {
  text = text.replace(
    /\| npm latest \(`@wasmagent\/core`\) \| v[\w.]+ \(published \d{4}-\d{2}-\d{2}\) \|/,
    `\| npm latest (\`@wasmagent/core\`) \| v${coreVersion.replace(/^v/, "")} (published ${today}) \|`
  );
}

if (text === before) {
  console.log("GOVERNANCE.md already current — nothing to do.");
  process.exit(0);
}

writeFileSync(file, text);
const git = (args) => execFileSync("git", args, { encoding: "utf8" });
git(["add", file]);
git([
  "-c",
  "user.name=release-bot",
  "-c",
  "user.email=release-bot@users.noreply.github.com",
  "commit",
  "-m",
  `docs: refresh GOVERNANCE current-state for ${today} [skip ci]`,
]);
console.log(`GOVERNANCE.md refreshed for ${today} and committed.`);
