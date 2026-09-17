#!/usr/bin/env node
/**
 * scripts/generate-release-provenance.mjs
 *
 * Emits a runtime `wasmagent-release-provenance/v1` artifact per package
 * PUBLISHED BY THIS RELEASE RUN (wired into release.yml, uploaded as the
 * `release-provenance` Actions artifact).
 *
 * Ownership rule: the published set comes from a PRE-PUBLISH candidate
 * snapshot (scripts/snapshot-release-candidates.mjs, taken before
 * `changeset publish`). A package whose exact version already existed on the
 * registry before the run belongs to an earlier release and can never be
 * attributed to this run — the generator refuses to run without a snapshot.
 *
 * Fail-closed rules:
 *   Rule 1  empty candidate set -> FAIL (publish happened, nothing recorded)
 *   Rule 2  candidate still missing from the registry after publish -> FAIL
 *   Rule 3  emitted artifact count must equal candidate count -> FAIL otherwise
 *   Rule 4  duplicate candidate names / publish destinations -> FAIL
 *
 * The schema is owned by the org contract repo (WasmAgent/.github,
 * scripts/org-contract/provenance.mjs + provenance.schema.json, Gate O4).
 * This script GENERATES conforming artifacts; the validation rules below
 * mirror the frozen v1 contract so a malformed artifact fails the release
 * loudly instead of shipping invalid evidence.
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
 * Usage:
 *   node scripts/generate-release-provenance.mjs \
 *     --candidates release-provenance/candidates.json \
 *     --out release-provenance
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const out = { candidates: null, out: "release-provenance", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--candidates") out.candidates = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
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

/**
 * Load and sanity-check a pre-publish candidates snapshot. Fails closed per
 * Rules 1 and 4: empty candidate list and duplicate names are ownership
 * violations, not warnings.
 */
export function loadCandidates(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("candidates file must be a JSON object");
  }
  const candidates = doc.candidates;
  if (!Array.isArray(candidates)) throw new Error("candidates file missing candidates[]");
  if (candidates.length === 0) {
    throw new Error(
      "Rule 1 violated: candidate set is empty — publish happened but the " +
        "pre-publish snapshot recorded nothing to attribute. Refusing to emit provenance."
    );
  }
  const seen = new Set();
  for (const c of candidates) {
    if (!c || typeof c.name !== "string" || typeof c.version !== "string") {
      throw new Error(`malformed candidate entry: ${JSON.stringify(c)}`);
    }
    if (seen.has(c.name)) {
      throw new Error(`Rule 4 violated: duplicate candidate name ${c.name}`);
    }
    seen.add(c.name);
  }
  return candidates.map((c) => ({ name: c.name, version: c.version }));
}

/**
 * Build one provenance artifact doc (pure; unit-testable).
 */
export function buildArtifact({
  name,
  version,
  sourceSha,
  workflowSha,
  lockSha256,
  toolchain,
  testRunIds,
  integrity,
}) {
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

/**
 * Build artifacts for all candidates (pure; unit-testable).
 * `resolveIntegrity(name, version)` returns the registry integrity or null.
 * Returns { artifacts, missing } — `missing` lists candidates the registry
 * does not serve after the publish (Rule 2).
 */
export function buildArtifacts(
  candidates,
  { resolveIntegrity, sourceSha, workflowSha, lockSha256, toolchain, testRunIds }
) {
  const artifacts = [];
  const missing = [];
  for (const { name, version } of candidates) {
    const integrity = resolveIntegrity(name, version);
    if (!integrity) {
      missing.push({ name, version });
      continue;
    }
    artifacts.push(
      buildArtifact({
        name,
        version,
        sourceSha,
        workflowSha,
        lockSha256,
        toolchain,
        testRunIds,
        integrity,
      })
    );
  }
  return { artifacts, missing };
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** Registry integrity for <name>@<version>, or null if absent. */
function registryIntegrity(name, version) {
  try {
    return sh("npm", ["view", `${name}@${version}`, "dist.integrity"]);
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = new URL("..", import.meta.url).pathname;

  if (!args.candidates) {
    console.error(
      "error: --candidates <snapshot-file> is required — provenance is only " +
        "emitted for the pre-publish candidate set (ownership rule)"
    );
    return 2;
  }

  let candidates;
  try {
    candidates = loadCandidates(JSON.parse(readFileSync(args.candidates, "utf8")));
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    return 1;
  }

  const sourceSha = process.env.GITHUB_SHA ?? sh("git", ["rev-parse", "HEAD"]);
  if (!HEX40.test(sourceSha)) {
    console.error(`source_sha is not 40-hex: ${sourceSha}`);
    return 2;
  }
  const workflowSha = sh("git", ["rev-parse", `${sourceSha}:.github/workflows/release.yml`]);
  const lockSha256 = createHash("sha256")
    .update(readFileSync(join(root, "bun.lock")))
    .digest("hex");
  const toolchain = `bun@${sh("bun", ["--version"])}/node@${process.versions.node}`;
  const runId = process.env.GITHUB_RUN_ID;
  const testRunIds = runId ? [String(runId)] : ["local"];

  const { artifacts, missing } = buildArtifacts(candidates, {
    resolveIntegrity: registryIntegrity,
    sourceSha,
    workflowSha,
    lockSha256,
    toolchain,
    testRunIds,
  });

  // Rule 2 — a candidate the registry still does not serve after publish is a
  // broken release, not a skippable entry.
  if (missing.length) {
    console.error(
      `FAIL Rule 2: ${missing.length} candidate(s) missing from registry after publish:`
    );
    for (const m of missing) console.error(`  - ${m.name}@${m.version}`);
    return 1;
  }
  // Rule 3 — one artifact per candidate, no more, no less.
  if (artifacts.length !== candidates.length) {
    console.error(
      `FAIL Rule 3: ${artifacts.length} artifact(s) for ${candidates.length} candidate(s)`
    );
    return 1;
  }

  if (!args.dryRun) mkdirSync(args.out, { recursive: true });

  let failures = 0;
  for (const doc of artifacts) {
    const problems = validateProvenance(doc);
    if (problems.length) {
      failures++;
      console.error(`FAIL ${doc.publish_destination}:`);
      for (const p of problems) console.error(`  - ${p}`);
      continue;
    }
    const file = join(
      args.out,
      `${doc.publish_destination.replace(/^npm:/, "").replace("@", "").replace("/", "-")}.provenance.json`
    );
    if (args.dryRun) {
      console.log(`dry-run ${file}`);
      console.log(JSON.stringify(doc, null, 2));
    } else {
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      console.log(`wrote ${file}`);
    }
  }
  if (failures) return 1;
  console.log(
    `release-provenance: ${artifacts.length} artifact(s) emitted for ${candidates.length} candidate(s) published by this run`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
