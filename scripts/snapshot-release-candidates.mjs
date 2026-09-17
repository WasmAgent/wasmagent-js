#!/usr/bin/env node
/**
 * scripts/snapshot-release-candidates.mjs
 *
 * Pre-publish ownership snapshot for runtime release provenance.
 *
 * Run BEFORE `changeset publish` in release.yml: scans public workspace
 * packages and records exactly those whose `<name>@<version>` does NOT yet
 * exist on the npm registry. Only these candidates can be attributed to the
 * publish that follows — a version already on the registry belongs to some
 * earlier release and must never appear in this run's provenance.
 *
 * The generator (scripts/generate-release-provenance.mjs) consumes the
 * written candidates file and fails closed if a candidate is still missing
 * after the publish, so the emitted provenance set is always:
 *
 *     published-by-this-run == pre-publish candidates == post-publish artifacts
 *
 * Usage: node scripts/snapshot-release-candidates.mjs --out <file>
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Pure candidate selection (unit-tested): a package is a publish candidate
 * for THIS run iff its exact name@version is absent from the registry right
 * now. Duplicate names collapse to the last occurrence (workspace layout
 * never produces them; guarded in the generator's uniqueness check).
 */
export function selectCandidates(packages, existsOnRegistry) {
  const candidates = [];
  for (const { name, version } of packages) {
    if (!existsOnRegistry(name, version)) {
      candidates.push({ name, version });
    }
  }
  return candidates;
}

export function publicPackages(root, readdirSync, readFileSync) {
  const dir = join(root, "packages");
  const found = [];
  for (const entry of readdirSync(dir)) {
    let json;
    try {
      json = JSON.parse(readFileSync(join(dir, entry, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (json.private || !json.name || !json.version) continue;
    found.push({ name: json.name, version: json.version });
  }
  return found;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** Registry existence for <name>@<version>. False when the version is absent. */
function existsOnRegistry(name, version) {
  try {
    return sh("npm", ["view", `${name}@${version}`, "version"]) === version;
  } catch {
    return false;
  }
}

function main(argv) {
  let out = ".release-provenance/candidates.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else {
      console.error(`unknown argument ${argv[i]}`);
      return 2;
    }
  }
  const root = new URL("..", import.meta.url).pathname;
  const packages = publicPackages(root, readdirSync, readFileSync);
  const candidates = selectCandidates(packages, existsOnRegistry);
  const doc = {
    captured_at: new Date().toISOString(),
    scanned: packages.length,
    candidates,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `release-candidates: ${candidates.length} candidate(s) out of ${packages.length} public package(s) -> ${out}`
  );
  for (const c of candidates) console.log(`  candidate ${c.name}@${c.version}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
