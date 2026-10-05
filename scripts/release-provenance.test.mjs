/**
 * Release-provenance ownership regression tests (RP-01..05).
 *
 * The emitted provenance set must equal the set of packages PUBLISHED BY
 * THIS RUN — i.e. the pre-publish candidate snapshot — never "every package
 * whose current version happens to resolve on the registry".
 *
 * Run: bun test scripts/release-provenance.test.mjs
 */
import { describe, expect, it } from "bun:test";
import {
  buildArtifacts,
  loadCandidates,
  validateProvenance,
} from "./generate-release-provenance.mjs";
import { selectCandidates } from "./snapshot-release-candidates.mjs";

const OLD = { name: "@wasmagent/core", version: "8.0.0" };
const NEW = { name: "@wasmagent/otel-exporter", version: "7.1.0" };

/** Registry stub: everything exists except the not-yet-published NEW version. */
function fakeRegistry(missing = [`${NEW.name}@${NEW.version}`]) {
  const absent = new Set(missing);
  return (name, version) => !absent.has(`${name}@${version}`);
}

function integrityOf(name, version) {
  return `sha512-fake-${name}-${version}`;
}

const BASE = {
  sourceSha: "a".repeat(40),
  workflowSha: "b".repeat(40),
  lockSha256: "c".repeat(64),
  toolchain: "bun@test/node@test",
  testRunIds: ["123"],
};

describe("release provenance ownership (RP-01..05)", () => {
  it("RP-01: packages already on the registry are excluded from candidates", () => {
    const packages = [OLD, { name: "@wasmagent/cli", version: "1.3.19" }];
    const candidates = selectCandidates(packages, fakeRegistry());
    expect(candidates).toEqual([]);
  });

  it("RP-02: a package whose version is absent pre-publish becomes the candidate", () => {
    const packages = [OLD, NEW];
    const candidates = selectCandidates(packages, fakeRegistry());
    expect(candidates).toEqual([NEW]);
  });

  it("RP-03: candidate still missing from registry after publish fails closed", () => {
    const candidates = [NEW];
    // Registry stub where even post-publish the version is not served.
    const { artifacts, missing } = buildArtifacts(candidates, {
      resolveIntegrity: () => null,
      ...BASE,
    });
    expect(artifacts).toEqual([]);
    expect(missing).toEqual([NEW]);
  });

  it("RP-04: publishing with an empty candidate set is rejected", () => {
    expect(() => loadCandidates({ candidates: [] })).toThrow(/Rule 1/);
    expect(() => loadCandidates({})).toThrow(/candidates/);
  });

  it("RP-05: mixed workspace (40 old + 1 new) emits exactly ONE artifact, bound to the new package", () => {
    const oldPackages = Array.from({ length: 40 }, (_, i) => ({
      name: `@wasmagent/pkg-${i}`,
      version: `1.0.${i}`,
    }));
    const packages = [...oldPackages, NEW];
    const candidates = selectCandidates(packages, fakeRegistry());
    expect(candidates).toEqual([NEW]);

    const { artifacts, missing } = buildArtifacts(candidates, {
      resolveIntegrity: (name, version) => integrityOf(name, version),
      ...BASE,
    });
    expect(missing).toEqual([]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].publish_destination).toBe(`npm:${NEW.name}@${NEW.version}`);

    const problems = validateProvenance(artifacts[0]);
    expect(problems).toEqual([]);
  });

  it("Rule 4: duplicate candidate names are rejected", () => {
    expect(() => loadCandidates({ candidates: [NEW, { ...NEW }] })).toThrow(/Rule 4/);
  });
});

// ── Registry retry classification matrix (post-release race fix) ────────────
// The security-critical distinction: ONLY replication lag (E404) is retried.
// Every other failure class fails without retry, so a real breakage cannot
// be masked. Pinned row-by-row.

import { classifyRegistryError, registryIntegrityWithRetry } from "./generate-release-provenance.mjs";

const RETRY_FAIL = (kind) => ({ ok: false, kind, message: kind });

describe("provenance registry retry — classification matrix", () => {
  it("classifies each failure mode into its own class", () => {
    expect(classifyRegistryError("npm error 404 No match found for version 1.0.0")).toBe("not-found");
    expect(classifyRegistryError("npm error code E404")).toBe("not-found");
    expect(classifyRegistryError("npm error code E401")).toBe("auth");
    expect(classifyRegistryError("npm error Incorrect or missing password. ENEEDAUTH")).toBe("auth");
    expect(classifyRegistryError("npm error code E403")).toBe("forbidden");
    expect(classifyRegistryError("npm error network ETIMEDOUT at socket")).toBe("network");
    expect(classifyRegistryError("npm error request to registry failed ECONNRESET")).toBe("network");
    expect(classifyRegistryError("npm error Unexpected token < in JSON")).toBe("other");
  });

  it("404 (replication lag) → retries up to the schedule, then gives up", async () => {
    let calls = 0;
    const result = await registryIntegrityWithRetry("p", "1.0.0", {
      delays: [1, 1, 1],
      sleepFn: async () => {},
      query: () => {
        calls++;
        return RETRY_FAIL("not-found");
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(4); // initial + 3 retries
  });

  it("401 auth → NO retry (single query)", async () => {
    let calls = 0;
    const result = await registryIntegrityWithRetry("p", "1.0.0", {
      delays: [1, 1, 1],
      sleepFn: async () => {},
      query: () => {
        calls++;
        return RETRY_FAIL("auth");
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it("403 forbidden → NO retry (single query)", async () => {
    let calls = 0;
    const result = await registryIntegrityWithRetry("p", "1.0.0", {
      delays: [1, 1, 1],
      sleepFn: async () => {},
      query: () => {
        calls++;
        return RETRY_FAIL("forbidden");
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it("network timeout → NO retry (single query)", async () => {
    let calls = 0;
    const result = await registryIntegrityWithRetry("p", "1.0.0", {
      delays: [1, 1, 1],
      sleepFn: async () => {},
      query: () => {
        calls++;
        return RETRY_FAIL("network");
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it("malformed integrity payload → NO retry (fail-closed on garbage)", async () => {
    let calls = 0;
    const result = await registryIntegrityWithRetry("p", "1.0.0", {
      delays: [1, 1, 1],
      sleepFn: async () => {},
      query: () => {
        calls++;
        return { ok: false, kind: "malformed", message: "unexpected integrity format: <html>" };
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it("a well-formed integrity resolves on the first query (no retries)", async () => {
    let calls = 0;
    const result = await registryIntegrityWithRetry("p", "1.0.0", {
      delays: [1, 1, 1],
      sleepFn: async () => {},
      query: () => {
        calls++;
        return { ok: true, integrity: "sha512-3VW9+aZjyFurftarIjesQfUa3bpHZC+rUvTV5oCnNu/6yiPq/wJlSsagnf+EskFRbiuU44HFtsDFQJf8ORJqFw==" };
      },
    });
    expect(result).toBe("sha512-3VW9+aZjyFurftarIjesQfUa3bpHZC+rUvTV5oCnNu/6yiPq/wJlSsagnf+EskFRbiuU44HFtsDFQJf8ORJqFw==");
    expect(calls).toBe(1);
  });
});
