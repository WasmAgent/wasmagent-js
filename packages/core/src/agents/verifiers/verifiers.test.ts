/**
 * Tests for the Verifier protocol family — DeterministicVerifier,
 * LLMJudgeVerifier, VerificationPipeline.
 *
 * All tests use in-memory `WorkspaceReader` fakes and (for LLMJudge)
 * scripted `Model` mocks. No real LLM calls.
 */

import type { Model, StreamEvent } from "../../models/types.js";
import {
  type Criterion,
  DeterministicVerifier,
  LLM_JUDGE_SYSTEM_PROMPT,
  LLMJudgeVerifier,
  VerificationPipeline,
  type Verifier,
  type WorkspaceReader,
} from "./index.js";

function fakeWs(files: Record<string, string>): WorkspaceReader {
  return {
    async readFile(path) {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path] ?? "";
    },
    async fileExists(path) {
      return path in files;
    },
    async fileSize(path) {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(files[path] ?? "").length;
    },
  };
}

/** Mock model that returns N scripted JSON judge replies in sequence. */
function scriptedJudgeModel(replies: string[]): {
  model: Model;
  callCount: () => number;
  capturedSystem: () => string | undefined;
} {
  let call = 0;
  let capturedSystem: string | undefined;
  const model: Model = {
    providerId: "mock/judge",
    async *generate(messages): AsyncGenerator<StreamEvent> {
      const sys = messages.find((m) => m.role === "system");
      if (sys && typeof sys.content === "string") capturedSystem = sys.content;
      const reply = replies[call] ?? replies[replies.length - 1] ?? "{}";
      call++;
      yield { type: "text_delta", delta: reply };
      yield { type: "usage", usage: { inputTokens: 80, outputTokens: 30 } };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
  return { model, callCount: () => call, capturedSystem: () => capturedSystem };
}

describe("DeterministicVerifier", () => {
  const v = new DeterministicVerifier();

  it("file_exists: pass when file present, fail when missing", async () => {
    const ws = fakeWs({ "a.md": "x" });
    expect(
      await v.verify(
        { id: "f", description: "exists", verify_method: "file_exists", path: "a.md" },
        ws
      )
    ).toEqual({ ok: true, criterionId: "f" });
    const fail = await v.verify(
      { id: "g", description: "exists", verify_method: "file_exists", path: "missing.md" },
      ws
    );
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.hint).toMatch(/does not exist/);
  });

  it("file_size_min: passes only when bytes >= arg", async () => {
    const ws = fakeWs({ "a.md": "0123456789" });
    const big = await v.verify(
      { id: "size", description: "≥10B", verify_method: "file_size_min", arg: 10, path: "a.md" },
      ws
    );
    expect(big.ok).toBe(true);
    const small = await v.verify(
      { id: "size", description: "≥99B", verify_method: "file_size_min", arg: 99, path: "a.md" },
      ws
    );
    expect(small.ok).toBe(false);
    if (!small.ok) expect(small.hint).toMatch(/10 bytes.*≥99/);
  });

  it("file_contains: pass when needle present", async () => {
    const ws = fakeWs({ "a.md": "Hello, World!" });
    const yes = await v.verify(
      {
        id: "c",
        description: "has greeting",
        verify_method: "file_contains",
        arg: "World",
        path: "a.md",
      },
      ws
    );
    expect(yes.ok).toBe(true);
    const no = await v.verify(
      {
        id: "c",
        description: "has marker",
        verify_method: "file_contains",
        arg: "ZZZZZ",
        path: "a.md",
      },
      ws
    );
    expect(no.ok).toBe(false);
  });

  it("file_matches: handles a valid regex and rejects an invalid one", async () => {
    const ws = fakeWs({ "a.md": "v1.2.3" });
    const ok = await v.verify(
      {
        id: "m",
        description: "semver",
        verify_method: "file_matches",
        arg: "^v\\d+\\.\\d+\\.\\d+$",
        path: "a.md",
      },
      ws
    );
    expect(ok.ok).toBe(true);
    const bad = await v.verify(
      {
        id: "m",
        description: "broken",
        verify_method: "file_matches",
        arg: "[unclosed",
        path: "a.md",
      },
      ws
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.hint).toMatch(/valid RegExp/);
  });

  it("headings_count_min: counts only line-leading # … ###### markers", async () => {
    const ws = fakeWs({
      "a.md": "# H1\n\nText with #not-a-heading inline.\n\n## H2\n\n### H3\n\n",
    });
    const enough = await v.verify(
      {
        id: "h",
        description: "≥3 headings",
        verify_method: "headings_count_min",
        arg: 3,
        path: "a.md",
      },
      ws
    );
    expect(enough.ok).toBe(true);
    const tooMany = await v.verify(
      {
        id: "h",
        description: "≥4 headings",
        verify_method: "headings_count_min",
        arg: 4,
        path: "a.md",
      },
      ws
    );
    expect(tooMany.ok).toBe(false);
  });

  it("word_count_min: counts CJK ideographs each as one word + Latin word tokens", async () => {
    const ws = fakeWs({ "zh.md": "半干电池技术介绍" }); // 8 CJK
    const r = await v.verify(
      {
        id: "wc",
        description: "≥5 字",
        verify_method: "word_count_min",
        arg: 5,
        path: "zh.md",
      },
      ws
    );
    expect(r.ok).toBe(true);
    const tooMany = await v.verify(
      {
        id: "wc",
        description: "≥9 字",
        verify_method: "word_count_min",
        arg: 9,
        path: "zh.md",
      },
      ws
    );
    expect(tooMany.ok).toBe(false);
    // Latin path
    const ws2 = fakeWs({ "en.md": "Hello world from WasmAgent verifier suite" });
    const ok = await v.verify(
      {
        id: "wc2",
        description: "≥6 words",
        verify_method: "word_count_min",
        arg: 6,
        path: "en.md",
      },
      ws2
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects criteria missing required path with a helpful failure", async () => {
    const ws = fakeWs({});
    // No `path` on a file_exists criterion → verifier throws internally;
    // pipeline catches it. Direct call shows the throw is the right
    // shape for the pipeline to rescue.
    await expect(
      v.verify({ id: "x", description: "missing path", verify_method: "file_exists" }, ws)
    ).rejects.toThrow(/requires a path/);
  });
});

describe("LLMJudgeVerifier", () => {
  const ws = fakeWs({ "doc.md": "Some prose about kittens." });
  const criterion: Criterion = {
    id: "depth",
    description: "covers all relevant aspects",
    verify_method: "llm_judge",
    path: "doc.md",
  };

  it("default samples=3 and unanimous policy: all pass → ok", async () => {
    const { model, callCount } = scriptedJudgeModel([
      `{"pass":true,"reasoning":"covers it"}`,
      `{"pass":true,"reasoning":"covers it"}`,
      `{"pass":true,"reasoning":"covers it"}`,
    ]);
    const v = new LLMJudgeVerifier({ model });
    const r = await v.verify(criterion, ws);
    expect(r.ok).toBe(true);
    expect(callCount()).toBe(3);
  });

  it("any single dissent fails when requirePassMajority=false (default)", async () => {
    const { model } = scriptedJudgeModel([
      `{"pass":true,"reasoning":"yes"}`,
      `{"pass":false,"reasoning":"missing applications section"}`,
      `{"pass":true,"reasoning":"yes"}`,
    ]);
    const v = new LLMJudgeVerifier({ model });
    const r = await v.verify(criterion, ws);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hint).toMatch(/missing applications section/);
      expect(r.hint).toMatch(/2\/3 passed/);
    }
  });

  it("majority policy passes when 2/3 pass", async () => {
    const { model } = scriptedJudgeModel([
      `{"pass":true,"reasoning":"yes"}`,
      `{"pass":false,"reasoning":"thin"}`,
      `{"pass":true,"reasoning":"yes"}`,
    ]);
    const v = new LLMJudgeVerifier({ model, requirePassMajority: true });
    const r = await v.verify(criterion, ws);
    expect(r.ok).toBe(true);
  });

  it("default-fail when reply is unparseable JSON", async () => {
    const { model } = scriptedJudgeModel([
      "I think the document is fine.",
      `{"pass":true,"reasoning":"valid"}`,
      `{"pass":true,"reasoning":"valid"}`,
    ]);
    const v = new LLMJudgeVerifier({ model });
    const r = await v.verify(criterion, ws);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/unparseable|2\/3/);
  });

  it("system prompt is the canonical adversarial one", async () => {
    const { model, capturedSystem } = scriptedJudgeModel([
      `{"pass":true,"reasoning":"x"}`,
      `{"pass":true,"reasoning":"x"}`,
      `{"pass":true,"reasoning":"x"}`,
    ]);
    const v = new LLMJudgeVerifier({ model });
    await v.verify(criterion, ws);
    expect(capturedSystem()).toBe(LLM_JUDGE_SYSTEM_PROMPT);
    // Lock the adversarial wording so a future copy edit can't soften it.
    expect(LLM_JUDGE_SYSTEM_PROMPT).toMatch(/REFUTE/);
    expect(LLM_JUDGE_SYSTEM_PROMPT).toMatch(/Default to pass: false/);
  });

  it("tolerates code-fence-wrapped JSON replies", async () => {
    const { model } = scriptedJudgeModel([
      '```json\n{"pass":true,"reasoning":"x"}\n```',
      '```\n{"pass":true,"reasoning":"x"}\n```',
      `{"pass":true,"reasoning":"x"}`,
    ]);
    const v = new LLMJudgeVerifier({ model });
    const r = await v.verify(criterion, ws);
    expect(r.ok).toBe(true);
  });

  it("missing artifact: judge sees `<none read>` and the loop reports a fail", async () => {
    const { model } = scriptedJudgeModel([
      `{"pass":false,"reasoning":"file not present"}`,
      `{"pass":false,"reasoning":"file not present"}`,
      `{"pass":false,"reasoning":"file not present"}`,
    ]);
    const v = new LLMJudgeVerifier({ model });
    const wsEmpty = fakeWs({});
    const r = await v.verify({ ...criterion, path: "missing.md" }, wsEmpty);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/file not present/);
  });
});

describe("VerificationPipeline", () => {
  it("dispatches each criterion to the matching verifier", async () => {
    const ws = fakeWs({ "a.md": "0123456789" });
    const pipe = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const result = await pipe.run([
      { id: "exists", description: "x", verify_method: "file_exists", path: "a.md" },
      {
        id: "size",
        description: "y",
        verify_method: "file_size_min",
        arg: 5,
        path: "a.md",
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.verdicts).toHaveLength(2);
  });

  it("aggregates failures into a single hint listing each failing criterion", async () => {
    const ws = fakeWs({});
    const pipe = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const result = await pipe.run([
      { id: "a", description: "doc exists", verify_method: "file_exists", path: "doc.md" },
      { id: "b", description: "code exists", verify_method: "file_exists", path: "code.ts" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.verdicts.every((v) => !v.ok)).toBe(true);
    expect(result.hint).toContain("a:");
    expect(result.hint).toContain("b:");
  });

  it("unknown verify_method becomes a fail verdict listing known methods", async () => {
    const ws = fakeWs({ "a.md": "x" });
    const pipe = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const result = await pipe.run([
      { id: "x", description: "weird", verify_method: "telepathy", path: "a.md" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.verdicts[0]?.ok).toBe(false);
      const v = result.verdicts[0];
      if (v && !v.ok) expect(v.hint).toMatch(/known methods.*file_exists/);
    }
  });

  it("verifier that throws is caught and rendered as a fail verdict", async () => {
    const ws = fakeWs({ "a.md": "x" });
    const angry: Verifier = {
      methods: ["mood"],
      async verify() {
        throw new Error("boom");
      },
    };
    const pipe = new VerificationPipeline({ ws, verifiers: [angry] });
    const result = await pipe.run([{ id: "z", description: "feels", verify_method: "mood" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.verdicts[0];
      if (v && !v.ok) expect(v.hint).toMatch(/threw: boom/);
    }
  });

  it("asGoalVerify produces a Goal-shaped verify function", async () => {
    const ws = fakeWs({ "a.md": "x" });
    const pipe = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const verifyOk = pipe.asGoalVerify([
      { id: "a", description: "x", verify_method: "file_exists", path: "a.md" },
    ]);
    expect(await verifyOk()).toEqual({ ok: true });
    const verifyFail = pipe.asGoalVerify([
      { id: "a", description: "x", verify_method: "file_exists", path: "missing.md" },
    ]);
    const r = await verifyFail();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("missing.md");
  });

  it("hint truncates with a count when failures exceed the cap", async () => {
    const ws = fakeWs({});
    const pipe = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    // Each fail line is ~40-50 chars; 30 of them blow past 600.
    const criteria: Criterion[] = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      description: `criterion ${i}`,
      verify_method: "file_exists",
      path: `f${i}.md`,
    }));
    const r = await pipe.run(criteria);
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/and \d+ more failure\(s\) omitted/);
    if (r.hint) expect(r.hint.length).toBeLessThan(900);
  });
});
