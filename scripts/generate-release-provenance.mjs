#!/usr/bin/env node
/**
 * scripts/generate-release-provenance.mjs
 *
 * Emits a runtime `wasmagent-release-provenance/v1` artifact per published
 * package after a real `changeset publish` (wired into release.yml, uploaded
 * as the `release-provenance` Actions artifact).
 *
 * The schema is owned by the org contract repo (WasmAgent/.github,
 * scripts/org-contract/provenance.mjs + provenance.schema.json, Gate O4).
 * This script GENERATES conforming artifacts; it does not redefine the
 * format. The validation rules below mirror the frozen v1 contract so a
 * malformed artifact fails the release loudly instead of shipping invalid
 * evidence.
 *
 * What each artifact binds:
 *   source_sha           — the commit the workflow ran on (github.sha)
 *   workflow_sha         — content SHA (git blob) of release.yml at that commit
 *   lock_sha256          — sha256 of bun.lock
 *   toolchain            — bun/node versions captured in the release job
 *   artifact_digest      — the registry integrity npm now serves for
 *                          <name>@<version> (proves the exact artifact)
 *   test_run_ids         — the release run id (it executed the build,
 *                          provable-chain gate and publish readiness checks)
 *   publish_destination  — npm:<name>@<version>
 *   outcome              — "published"
 *
 * A published package is discovered by resolving <name>@<version> from each
 * public workspace package against the registry — right after changeset
 * publish in the same job, "registry serves this exact version" is the
 * ground truth of what was published.
 *
 * Usage: node scripts/generate-release-provenance.mjs --out <dir> [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FORMAT = "wasmagent-release-provenance/v1";
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OUTCOMES = ["published", "deployed", "dry-run", "skipped", "failed"];
const REQUIRED_FIELDS = [
  "format",
  "source_sha",
  "workflow_sha",
  "lock_sha256",
  "toolchain",
  "artifact_digest",
  "test_run_ids",
  "publish_destination",
  "outcome",
];

function parseArgs(argv) {
  const out = { out: ".release-provenance", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else {
      console.error(`unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

/** Mirror of the frozen v1 validator (org contract provenance.mjs). */
export function validateProvenance(doc) {
  const problems = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return ["provenance artifact must be a JSON object"];
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in doc)) problems.push(`missing required field: ${field}`);
  }
  if (doc.format !== FORMAT) problems.push(`format must be "${FORMAT}"`);
  for (const field of ["source_sha", "workflow_sha"]) {
    if (field in doc && !HEX40.test(String(doc[field]))) {
      problems.push(`${field} must be a full 40-hex SHA`);
    }
  }
  if ("lock_sha256" in doc && !HEX64.test(String(doc.lock_sha256))) {
    problems.push("lock_sha256 must be a full 64-hex sha256");
  }
  for (const field of ["toolchain", "artifact_digest", "publish_destination"]) {
    if (field in doc && !(typeof doc[field] === "string" && doc[field].length > 0)) {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  if ("test_run_ids" in doc) {
    if (!Array.isArray(doc.test_run_ids) || doc.test_run_ids.length === 0) {
      problems.push("test_run_ids must be a non-empty array");
    } else if (!doc.test_run_ids.every((v) => typeof v === "string" && v.length > 0)) {
      problems.push("test_run_ids entries must be non-empty strings");
    }
  }
  if ("outcome" in doc && !OUTCOMES.includes(doc.outcome)) {
    problems.push(`outcome must be one of: ${OUTCOMES.join(", ")}`);
  }
  return problems;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** Registry integrity for <name>@<version>, or null if the version is absent. */
function registryIntegrity(name, version) {
  try {
    return sh("npm", ["view", `${name}@${version}`, "dist.integrity"]);
  } catch {
    return null;
  }
}

function publicPackages(root) {
  const dir = join(root, "packages");
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry, "package.json");
    let json;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (json.private || !json.name || !json.version) continue;
    found.push({ name: json.name, version: json.version });
  }
  return found;
}

export function buildArtifact({ name, version, sourceSha, workflowSha, lockSha256, toolchain, testRunIds, integrity }) {
  return {
    format: FORMAT,
    source_sha: sourceSha,
    workflow_sha: workflowSha,
    lock_sha256: lockSha256,
    toolchain,
    artifact_digest: integrity,
    test_run_ids: testRunIds,
    publish_destination: `npm:${name}@${version}`,
    outcome: "published",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = new URL("..", import.meta.url).pathname;

  const sourceSha = process.env.GITHUB_SHA ?? sh("git", ["rev-parse", "HEAD"]);
  if (!HEX40.test(sourceSha)) {
    console.error(`source_sha is not 40-hex: ${sourceSha}`);
    return 2;
  }
  const workflowSha = sh("git", ["rev-parse", `${sourceSha}:.github/workflows/release.yml`]);
  const lockSha256 = createHash("sha256").update(readFileSync(join(root, "bun.lock"))).digest("hex");
  const toolchain = `bun@${sh("bun", ["--version"])}/node@${process.versions.node}`;
  const runId = process.env.GITHUB_RUN_ID;
  const testRunIds = runId ? [String(runId)] : ["local"];

  const published = [];
  for (const { name, version } of publicPackages(root)) {
    const integrity = registryIntegrity(name, version);
    if (!integrity) continue; // this version is not on the registry — not published (yet)
    published.push({ name, version, integrity });
  }

  if (published.length === 0) {
    console.log("release-provenance: no published packages detected — nothing to record");
    return 0;
  }

  if (!args.dryRun) mkdirSync(args.out, { recursive: true });

  let failures = 0;
  for (const { name, version, integrity } of published) {
    const doc = buildArtifact({
      name,
      version,
      sourceSha,
      workflowSha,
      lockSha256,
      toolchain,
      testRunIds,
      integrity,
    });
    const problems = validateProvenance(doc);
    if (problems.length) {
      failures++;
      console.error(`FAIL ${name}@${version}:`);
      for (const p of problems) console.error(`  - ${p}`);
      continue;
    }
    const file = join(args.out, `${name.replace("@", "").replace("/", "-")}-v${version}.provenance.json`);
    if (args.dryRun) {
      console.log(`dry-run ${file}`);
      console.log(JSON.stringify(doc, null, 2));
    } else {
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      console.log(`wrote ${file}`);
    }
  }
  return failures ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
