import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import type { RiskCategory } from "./vetting.js";
import { evaluateAdversarial, vetTool } from "./vetting.js";

// ── Valid RiskCategory values ────────────────────────────────────────────────

const VALID_RISK_CATEGORIES: RiskCategory[] = [
  "command_execution",
  "credential_access",
  "exfiltration",
  "invisible_chars",
  "privilege_escalation",
  "rug_pull",
  "sampling_abuse",
  "shadowing",
  "ssrf",
  "supply_chain",
  "tool_poisoning",
];

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbToolName = fc.string({ minLength: 0, maxLength: 200 });
const arbDescription = fc.string({ minLength: 0, maxLength: 2000 });
const arbInputSchema = fc.oneof(
  fc.constant({ type: "object", properties: {} }),
  fc.record({
    type: fc.constant("object"),
    properties: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.constant({ type: "string" })
    ),
  }),
  fc.jsonValue().map((v) => (typeof v === "object" && v !== null ? v : { type: "object" }))
);

const arbMcpToolEntry = fc.record({
  name: arbToolName,
  description: arbDescription,
  inputSchema: arbInputSchema,
});

// ── Property: vetTool never throws ──────────────────────────────────────────

describe("vetTool — property-based", () => {
  it("never crashes regardless of input shape", () => {
    fc.assert(
      fc.property(arbMcpToolEntry, (entry) => {
        // vetTool must not throw for any well-formed McpToolEntry
        const result = vetTool(entry);
        expect(result).toBeDefined();
        expect(result.toolName).toBe(entry.name);
        expect(typeof result.blocked).toBe("boolean");
        expect(["allow", "ask", "deny"]).toContain(result.recommendation);
      }),
      { numRuns: 200 }
    );
  });

  it("findings always contain valid RiskCategory values", () => {
    fc.assert(
      fc.property(arbMcpToolEntry, (entry) => {
        const result = vetTool(entry);
        for (const finding of result.findings) {
          expect(VALID_RISK_CATEGORIES).toContain(finding.category);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("findings always have valid severity and recommendation", () => {
    fc.assert(
      fc.property(arbMcpToolEntry, (entry) => {
        const result = vetTool(entry);
        for (const finding of result.findings) {
          expect(["low", "medium", "high", "critical"]).toContain(finding.severity);
          expect(["allow", "ask", "deny"]).toContain(finding.recommendation);
          expect(["name", "description", "inputSchema"]).toContain(finding.field);
          expect(typeof finding.evidenceExcerpt).toBe("string");
          expect(typeof finding.evidenceHash).toBe("string");
        }
      }),
      { numRuns: 200 }
    );
  });

  it("blocked is true if and only if recommendation is deny", () => {
    fc.assert(
      fc.property(arbMcpToolEntry, (entry) => {
        const result = vetTool(entry);
        expect(result.blocked).toBe(result.recommendation === "deny");
      }),
      { numRuns: 200 }
    );
  });
});

// ── Property: evaluateAdversarial risk scores are bounded [0, 1] ────────────

describe("evaluateAdversarial — property-based", () => {
  it("score is always between 0 and 1 inclusive", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 3000 }), (text) => {
        const result = evaluateAdversarial(text);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 }
    );
  });

  it("never crashes on arbitrary unicode input", () => {
    fc.assert(
      fc.property(fc.fullUnicode(), (text) => {
        const result = evaluateAdversarial(text);
        expect(result).toBeDefined();
        expect(typeof result.score).toBe("number");
        expect(Array.isArray(result.hits)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it("hits always have positive weight", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 2000 }), (text) => {
        const result = evaluateAdversarial(text);
        for (const hit of result.hits) {
          expect(hit.weight).toBeGreaterThan(0);
          expect(typeof hit.ngram).toBe("string");
        }
      }),
      { numRuns: 200 }
    );
  });

  it("empty string produces score of 0.5 (sigmoid(0))", () => {
    const result = evaluateAdversarial("");
    expect(result.score).toBe(0.5);
    expect(result.hits).toHaveLength(0);
  });
});
