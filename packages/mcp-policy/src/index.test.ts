import { describe, expect, it } from "bun:test";
import { PolicyBundle } from "./bundle.js";

describe("PolicyBundle", () => {
  it("default() has rules and a digest", () => {
    const b = PolicyBundle.default();
    expect(b.rules.length).toBeGreaterThan(0);
    expect(b.digest).toHaveLength(64);
  });

  it("digest changes when rules change", () => {
    const b1 = PolicyBundle.default();
    const b2 = PolicyBundle.strict();
    expect(b1.digest).not.toBe(b2.digest);
  });

  it("extend() adds rules", () => {
    const base = PolicyBundle.default();
    const custom = { policyId: "custom", evaluate: () => undefined };
    const extended = base.extend([custom]);
    expect(extended.rules.length).toBe(base.rules.length + 1);
  });
});
