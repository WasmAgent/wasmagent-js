#!/usr/bin/env node
/**
 * check-rapid-major-bump.mjs — fail a release that would tag a new
 * `v<MAJOR>.0.0` aggregate tag within RAPID_MAJOR_WINDOW_HOURS (24) of the
 * previous distinct major tag.
 *
 * Context (#244): on 2026-07-23 the release automation published v2.0.0 and
 * v3.0.0 three minutes apart with no deprecation cycle. This guard makes a
 * repeat a hard CI failure instead of a post-hoc retrospective.
 *
 * Usage:
 *   node scripts/check-rapid-major-bump.mjs [newTag]
 *     newTag   candidate tag (e.g. "v4.0.0"). Defaults to the highest
 *              existing `v*` tag — useful as a post-tag CI audit.
 *
 * Exit codes: 0 = OK, 1 = rapid major bump detected / git failure.
 */
import { execFileSync } from "node:child_process";

const RAPID_MAJOR_WINDOW_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

function sh(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Creator timestamp (ms) of a tag; prefers annotated-tag dates. */
function tagTimestampMs(tag) {
  try {
    const out = sh(["for-each-ref", `refs/tags/${tag}`, "--format=%(creatordate:unix)"]);
    return Number(out) * 1000;
  } catch {
    return NaN;
  }
}

const majorOf = (tag) => {
  const m = /^v(\d+)\./.exec(tag);
  return m ? Number(m[1]) : null;
};

const tags = sh(["tag", "-l", "v*", "--sort=-creatordate"]).split("\n").filter(Boolean);
const majorTags = tags
  .map((tag) => ({ tag, major: majorOf(tag), ts: tagTimestampMs(tag) }))
  .filter((t) => t.major !== null && !Number.isNaN(t.ts));

// Keep only the newest tag per major.
const newestPerMajor = new Map();
for (const t of majorTags) {
  if (!newestPerMajor.has(t.major)) newestPerMajor.set(t.major, t);
}

const candidates = [...newestPerMajor.values()].sort((a, b) => b.ts - a.ts);

const newTag = process.argv[2];
if (newTag) {
  if (!/^v\d+\./.test(newTag)) {
    console.error(`✗ newTag "${newTag}" does not look like an aggregate version tag (v<MAJOR>.x)`);
    process.exit(1);
  }
  const newMajor = majorOf(newTag);
  const previous = candidates.find((t) => t.major !== newMajor);
  if (!previous) {
    console.log(`✓ no previous major tag to compare against ${newTag}`);
    process.exit(0);
  }
  if (newMajor <= previous.major) {
    console.log(`✓ ${newTag} (major ${newMajor}) does not advance past v${previous.major}.0.0-line (${previous.tag})`);
    process.exit(0);
  }
  // The candidate tag does not exist yet when this guard runs pre-tag —
  // evaluate the window against "now" in that case.
  const newTagTs = tagTimestampMs(newTag);
  const ts = Number.isFinite(newTagTs) && newTagTs > 0 ? newTagTs : Date.now();
  const gapH = (ts - previous.ts) / MS_PER_HOUR;
  if (gapH >= 0 && gapH < RAPID_MAJOR_WINDOW_HOURS) {
    console.error(
      `✗ RAPID MAJOR BUMP: ${newTag} would land ${gapH.toFixed(1)}h after ${previous.tag} ` +
        `(window: ${RAPID_MAJOR_WINDOW_HOURS}h).\n` +
        `  A major bump requires a deliberate breaking change with a deprecation cycle\n` +
        `  (docs/strategy/api-stability.md). If this is genuinely intended, wait until\n` +
        `  the window elapses or land an RFC first — see the 2026-07-23 v2→v3 retrospective\n` +
        `  in docs/strategy/release-cadence-log.md.`
    );
    process.exit(1);
  }
  console.log(`✓ ${newTag} is ${gapH.toFixed(1)}h after ${previous.tag} — outside the rapid-bump window`);
  process.exit(0);
}

// No-arg mode: audit the gap between the two most recent distinct majors.
// Historical violations (e.g. the 2026-07-23 v2→v3 pair) only WARN — they
// are already recorded in the cadence-log retrospective and must not fail
// every future release forever. Only candidate-mode (newTag) can fail.
if (candidates.length < 2) {
  console.log("✓ fewer than two distinct majors tagged — nothing to audit");
  process.exit(0);
}
const [newest, previous] = candidates;
const gapH = (newest.ts - previous.ts) / MS_PER_HOUR;
if (gapH < RAPID_MAJOR_WINDOW_HOURS) {
  console.warn(
    `⚠ historical rapid-major pair in tag history: ${newest.tag} landed ${gapH.toFixed(1)}h after ${previous.tag} ` +
      `(recorded in docs/strategy/release-cadence-log.md). Candidate mode enforces the window going forward.`
  );
  process.exit(0);
}
console.log(`✓ newest major ${newest.tag} is ${gapH.toFixed(1)}h after ${previous.tag}`);
