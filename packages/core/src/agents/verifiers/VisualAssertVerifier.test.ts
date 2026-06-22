import { VisualAssertVerifier, type VisualResult } from "./VisualAssertVerifier.js";

const nullWs = {
  async readFile() {
    return "";
  },
  async fileExists() {
    return false;
  },
  async fileSize() {
    return 0;
  },
};

function makeCriterion(sessionId?: string) {
  return {
    id: "visual-1",
    description: "UI must match baseline",
    verify_method: "visual_assert" as const,
    arg: sessionId,
  };
}

function makeReader(result: VisualResult | null) {
  return async () => result;
}

describe("VisualAssertVerifier", () => {
  test("verdict=pass → ok:true", async () => {
    const v = new VisualAssertVerifier({ getVisualResult: makeReader({ verdict: "pass" }) });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(true);
  });

  test("verdict=fail → ok:false with reason", async () => {
    const v = new VisualAssertVerifier({
      getVisualResult: makeReader({ verdict: "fail", reason: "pixel diff exceeded threshold" }),
    });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("pixel diff");
  });

  test("verdict=pending → ok:false (must not default to pass)", async () => {
    const v = new VisualAssertVerifier({ getVisualResult: makeReader({ verdict: "pending" }) });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("not yet complete");
  });

  test("verdict=unknown → ok:false (must not default to pass)", async () => {
    const v = new VisualAssertVerifier({ getVisualResult: makeReader({ verdict: "unknown" }) });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
  });

  test("null result → ok:false", async () => {
    const v = new VisualAssertVerifier({ getVisualResult: async () => null });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
  });

  test("missing session id → ok:false with descriptive hint", async () => {
    const v = new VisualAssertVerifier({ getVisualResult: async () => null });
    const verdict = await v.verify(makeCriterion(undefined), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("session ID");
  });

  test("getVisualResult throws → ok:false with error hint", async () => {
    const v = new VisualAssertVerifier({
      getVisualResult: async () => {
        throw new Error("network timeout");
      },
    });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("network timeout");
  });
});
