/**
 * IFEval loader integration — load the curated 50-sample subset off
 * disk and confirm:
 *   1. Every sample produces a parseable TaskSpec.
 *   2. Every constraint's `verify_method` is one IFEvalVerifier handles.
 *   3. The verifier returns the *expected pass-or-fail* when fed
 *      synthetic gold/junk responses.
 *
 * If any of these fail, either the curation step drifted (new
 * instruction_id classes appeared) or IFEvalVerifier is missing a
 * branch. Either way, the failure points at the right file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeterministicVerifier, VerificationPipeline, type WorkspaceReader } from "@wasmagent/core";
import { TaskSpecSchema } from "../../src/ir/ConstraintIR.js";
import { ComplianceVerifier } from "../../src/verifier/ComplianceVerifier.js";
import { IFEvalVerifier } from "../../src/verifier/ifeval/IFEvalVerifier.js";
import { loadIFEvalSamples } from "./load.js";

const SAMPLES_PATH = join(import.meta.dir, "samples.jsonl");

// Lazy load — keep tests fast for the verifier-only file by not
// touching disk unless this test file runs.
const loaded = loadIFEvalSamples(SAMPLES_PATH);

describe("IFEval loader", () => {
  test("loads exactly 50 samples", () => {
    expect(loaded.length).toBe(50);
  });

  test("every TaskSpec passes Zod validation", () => {
    for (const { spec } of loaded) {
      expect(() => TaskSpecSchema.parse(spec)).not.toThrow();
    }
  });

  test("every constraint's verify_method is registered with IFEvalVerifier", () => {
    const supported = new Set(new IFEvalVerifier().methods);
    for (const { spec } of loaded) {
      for (const c of spec.constraints) {
        expect(supported.has(c.verify_method)).toBe(true);
      }
    }
  });

  test("constraint ids are unique within a sample", () => {
    for (const { spec } of loaded) {
      const ids = spec.constraints.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("IFEvalVerifier × loader handshake (synthetic responses)", () => {
  // "junk" response — short, English, has comma & uppercase, no bullets,
  // no quotes, no <<title>>, no [placeholders], no Markdown highlights.
  // This violates *positive-bound* constraints (at-least counts, required
  // keywords, structural markers) but trivially passes *negative-bound*
  // constraints (less-than counts, forbidden-word lists). That's
  // expected — the junk-response check below tightens its assertion to
  // "every sample with a positive-bound constraint must fail at least
  // one of them".
  const junkResponse = "Hi, THIS HAS COMMAS AND UPPERCASE AND NO STRUCTURE";

  /** Build a workspace where every response file resolves to `body`. */
  function uniformWorkspace(body: string): WorkspaceReader {
    return {
      async readFile() {
        return body;
      },
      async fileExists() {
        return true;
      },
      async fileSize() {
        return Buffer.byteLength(body, "utf8");
      },
    };
  }

  test("junk response fails every sample that has a positive-bound constraint", async () => {
    // Whitelist of methods+args shapes that junk vacuously satisfies.
    // The test assertion below excludes samples whose *every*
    // constraint is on this list — those are negative-bound and a
    // minimal-junk response is legitimately compliant.
    const isVacuouslySatisfiable = (verifyMethod: string, arg: unknown): boolean => {
      const obj = (arg ?? {}) as Record<string, unknown>;
      if (verifyMethod === "ifeval:length_constraints:number_words" && obj.relation === "less than")
        return true;
      if (
        verifyMethod === "ifeval:length_constraints:number_sentences" &&
        obj.relation === "less than"
      )
        return true;
      if (verifyMethod === "ifeval:keywords:letter_frequency" && obj.let_relation === "less than")
        return true;
      if (verifyMethod === "ifeval:keywords:forbidden_words") return true;
      return false;
    };

    const pipeline = new VerificationPipeline({
      ws: uniformWorkspace(junkResponse),
      verifiers: [new IFEvalVerifier(), new DeterministicVerifier()],
    });
    const verifier = new ComplianceVerifier({ pipeline });
    for (const { spec } of loaded) {
      const allVacuous = spec.constraints.every((c) =>
        isVacuouslySatisfiable(c.verify_method, c.arg)
      );
      const result = await verifier.verify(spec);
      if (allVacuous) {
        // Junk legitimately passes — assert that and move on.
        expect(result.ok).toBe(true);
      } else {
        // At least one positive-bound constraint exists; junk MUST
        // violate something.
        expect(result.ok).toBe(false);
      }
    }
  });

  test("verifier returns proper violations with category and evidence_span", async () => {
    const pipeline = new VerificationPipeline({
      ws: uniformWorkspace(junkResponse),
      verifiers: [new IFEvalVerifier()],
    });
    const verifier = new ComplianceVerifier({ pipeline });
    const { spec } = loaded[0]!;
    const result = await verifier.verify(spec);
    expect(result.violations.length).toBeGreaterThan(0);
    for (const v of result.violations) {
      expect(v.constraint_id).toMatch(/^\d+:\d+:/);
      expect(["format", "content", "style"]).toContain(v.category);
      // Default span set by ComplianceVerifier.
      expect(v.evidence_span?.region_id).toBeDefined();
      expect(v.detected_at).toBe("post_decode");
    }
  });
});

describe("IFEval samples.jsonl provenance", () => {
  test("sha256 matches the README tripwire", async () => {
    const expected = "038b9782ed9250f9ceac383a0507f9fb3f36ec169366818d058faa0991741a0d";
    const buf = readFileSync(SAMPLES_PATH);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(expected);
  });
});
