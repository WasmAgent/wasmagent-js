import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  buildJavySource,
  computeHostHmac,
  ENVELOPE_MAGIC,
  STATE_RESTORE_RESERVED,
} from "./WasmtimeKernel.js";

// ── Property: buildJavySource never crashes ─────────────────────────────────

describe("buildJavySource — property-based", () => {
  it("never throws regardless of code content", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (code) => {
          const source = buildJavySource(code, [], {}, {});
          expect(typeof source).toBe("string");
          expect(source.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 150 }
    );
  });

  it("never throws with arbitrary allowedHosts and env", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        fc.array(fc.domain(), { maxLength: 5 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 50 })),
        (code, hosts, env) => {
          const source = buildJavySource(code, hosts, {}, env);
          expect(typeof source).toBe("string");
          expect(source).toContain("Javy harness");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("always includes the envelope magic bytes as a literal", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (code) => {
          const source = buildJavySource(code, [], {}, {});
          // The magic bytes [0x57, 0x41, 0x53, 0x4d, 0x41, 0x47, 0x4e, 0x54]
          // are embedded in the harness as a comma-separated literal.
          expect(source).toContain("87,65,83,77,65,71,78,84");
        }
      ),
      { numRuns: 50 }
    );
  });

  it("state bag with reserved keys does not crash compilation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STATE_RESTORE_RESERVED),
        fc.string({ minLength: 1, maxLength: 50 }),
        (reservedKey, value) => {
          const state: Record<string, string> = { [reservedKey]: JSON.stringify(value) };
          const source = buildJavySource("1+1", [], state, {});
          expect(typeof source).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ── Property: computeHostHmac ────────────────────────────────────────────────

describe("computeHostHmac — property-based", () => {
  it("returns empty string when secret is empty", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (runId, payload) => {
          expect(computeHostHmac(runId, payload, "")).toBe("");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("always returns a 16-char hex string when secret is non-empty", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 0, maxLength: 500 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        (runId, payload, secret) => {
          const tag = computeHostHmac(runId, payload, secret);
          expect(tag).toMatch(/^[0-9a-f]{16}$/);
        }
      ),
      { numRuns: 150 }
    );
  });

  it("is deterministic (same inputs produce same output)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 0, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (runId, payload, secret) => {
          const tag1 = computeHostHmac(runId, payload, secret);
          const tag2 = computeHostHmac(runId, payload, secret);
          expect(tag1).toBe(tag2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("different secrets produce different tags (with high probability)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 4, maxLength: 32 }),
        fc.string({ minLength: 4, maxLength: 32 }),
        (runId, payload, secret1, secret2) => {
          fc.pre(secret1 !== secret2);
          const tag1 = computeHostHmac(runId, payload, secret1);
          const tag2 = computeHostHmac(runId, payload, secret2);
          // With 64-bit hash space, collision probability is negligible
          expect(tag1).not.toBe(tag2);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property: ENVELOPE_MAGIC invariants ──────────────────────────────────────

describe("ENVELOPE_MAGIC — invariants", () => {
  it("is exactly 8 bytes spelling WASMAGNT", () => {
    expect(ENVELOPE_MAGIC).toBeInstanceOf(Uint8Array);
    expect(ENVELOPE_MAGIC.length).toBe(8);
    const decoded = new TextDecoder().decode(ENVELOPE_MAGIC);
    expect(decoded).toBe("WASMAGNT");
  });
});
