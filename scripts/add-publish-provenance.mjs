#!/usr/bin/env node
/**
 * scripts/add-publish-provenance.mjs (D4 Trust Page, 2026-06-13)
 *
 * Idempotent script that ensures every package's `publishConfig` includes
 * `provenance: true`. Without this flag, npm's `--provenance` request from
 * release.yml is honoured per-publish but the package metadata itself does
 * NOT advertise the provenance contract — auditors comparing two npm
 * registry pages see nothing distinguishing.
 *
 * Run before any `changesets publish`. The Trust Page links to this script
 * so reviewers can verify it actually runs.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../packages", import.meta.url).pathname;
let touched = 0;
let already = 0;

for (const pkg of readdirSync(root)) {
  const path = join(root, pkg, "package.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    continue; // not every dir has a package.json (e.g. dist artefacts)
  }
  const json = JSON.parse(raw);
  if (json.private) continue; // not published
  if (!json.publishConfig) json.publishConfig = { access: "public" };
  if (json.publishConfig.provenance === true) {
    already++;
    continue;
  }
  json.publishConfig.provenance = true;
  // Preserve trailing newline + 2-space indent — matches Biome's format.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  touched++;
  console.log(`provenance: true → ${pkg}`);
}

console.log(`\n✅ ${touched} touched, ${already} already had provenance:true.`);
