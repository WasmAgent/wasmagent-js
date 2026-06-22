import { BuildPassesVerifier, type BuildResult } from "./BuildPassesVerifier.js";

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
    id: "build-1",
    description: "build must pass",
    verify_method: "build_passes" as const,
    arg: sessionId,
  };
}

function makeReader(result: BuildResult | null): (id: string) => Promise<BuildResult | null> {
  return async () => result;
}

describe("BuildPassesVerifier", () => {
  test("exitCode=0 → ok:true", async () => {
    const v = new BuildPassesVerifier({
      getBuildResult: makeReader({ status: "success", exitCode: 0, stdout: "", stderr: "" }),
    });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(true);
  });

  test("exitCode≠0 → ok:false with summarized stderr hint", async () => {
    const v = new BuildPassesVerifier({
      getBuildResult: makeReader({
        status: "failure",
        exitCode: 1,
        stdout: "",
        stderr: "Error: module not found\n at compile step",
      }),
    });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("module not found");
  });

  test("status=running → ok:false (must not default to pass)", async () => {
    const v = new BuildPassesVerifier({
      getBuildResult: makeReader({ status: "running", exitCode: null, stdout: "", stderr: "" }),
    });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("not yet complete");
  });

  test("status=unknown → ok:false (must not default to pass)", async () => {
    const v = new BuildPassesVerifier({
      getBuildResult: makeReader({ status: "unknown", exitCode: null, stdout: "", stderr: "" }),
    });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
  });

  test("null result → ok:false", async () => {
    const v = new BuildPassesVerifier({ getBuildResult: async () => null });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
  });

  test("missing session id → ok:false with descriptive hint", async () => {
    const v = new BuildPassesVerifier({ getBuildResult: async () => null });
    const verdict = await v.verify(makeCriterion(undefined), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("session ID");
  });

  test("getBuildResult throws → ok:false with error hint", async () => {
    const v = new BuildPassesVerifier({
      getBuildResult: async () => {
        throw new Error("KV timeout");
      },
    });
    const verdict = await v.verify(makeCriterion("sess-1"), nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("KV timeout");
  });
});
