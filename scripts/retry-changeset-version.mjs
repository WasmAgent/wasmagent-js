#!/usr/bin/env node
/**
 * retry-changeset-version.mjs
 *
 * Wraps `changeset version` with up to N retries to work around the
 * intermittent `Premature close` / `ERR_STREAM_PREMATURE_CLOSE` error
 * coming from @changesets/get-github-info@0.8.0 → node-fetch@2.
 *
 * Root cause (see https://github.com/changesets/changesets/issues/2123):
 *   - get-github-info still uses node-fetch@2
 *   - node-fetch@2 has a keep-alive bug (node-fetch/node-fetch#1219)
 *   - A recent Node http.Agent change (nodejs/node#63989) exposes the bug
 *     when fetching GitHub's GraphQL API
 *   - It fails-safe: no partial release happens, a re-run works
 *
 * Long-term fix is changesets v3 (already removed node-fetch in prereleases).
 * Until then this wrapper makes CI not red on the first transient hit.
 *
 * Usage in package.json:
 *   "release:version": "node scripts/retry-changeset-version.mjs"
 */

import { spawn } from "node:child_process";

const MAX_ATTEMPTS = Number(process.env.CHANGESET_VERSION_MAX_ATTEMPTS ?? 4);
const BASE_DELAY_MS = Number(process.env.CHANGESET_VERSION_BASE_DELAY_MS ?? 5_000);

function run(cmd, args) {
  return new Promise((resolve) => {
    const out = [];
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (b) => {
      process.stdout.write(b);
      out.push(b.toString("utf8"));
    });
    child.stderr.on("data", (b) => {
      process.stderr.write(b);
      out.push(b.toString("utf8"));
    });
    child.on("close", (code) => resolve({ code, output: out.join("") }));
  });
}

function isTransient(output) {
  return (
    output.includes("Premature close") ||
    output.includes("ERR_STREAM_PREMATURE_CLOSE") ||
    output.includes("Failed to parse data from GitHub") ||
    output.includes("Invalid response body while trying to fetch https://api.github.com")
  );
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let attempt = 0;
while (attempt < MAX_ATTEMPTS) {
  attempt++;
  if (attempt > 1) {
    const delay = BASE_DELAY_MS * 2 ** (attempt - 2);
    console.log(
      `\n[retry-changeset-version] attempt ${attempt}/${MAX_ATTEMPTS} after ${delay} ms backoff…`,
    );
    await sleep(delay);
  }

  const { code, output } = await run("npx", ["changeset", "version"]);

  if (code === 0) {
    if (attempt > 1) {
      console.log(`[retry-changeset-version] succeeded on attempt ${attempt}.`);
    }
    process.exit(0);
  }

  if (!isTransient(output)) {
    console.error(
      `\n[retry-changeset-version] non-transient failure (exit ${code}); not retrying.`,
    );
    process.exit(code ?? 1);
  }

  console.warn(
    `\n[retry-changeset-version] transient GraphQL/node-fetch error on attempt ${attempt} (see https://github.com/changesets/changesets/issues/2123).`,
  );
}

console.error(
  `\n[retry-changeset-version] giving up after ${MAX_ATTEMPTS} attempts. ` +
    `If this persists, consider upgrading to @changesets/cli v3 prerelease which removed node-fetch@2.`,
);
process.exit(1);
