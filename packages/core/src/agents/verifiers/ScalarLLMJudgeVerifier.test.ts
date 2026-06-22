import type { Model, ModelEvent } from "../../models/types.js";
import { ScalarLLMJudgeVerifier, type ScalarVerdict } from "./ScalarLLMJudgeVerifier.js";
import type { WorkspaceReader } from "./types.js";

// ── Test double: configurable mock model ─────────────────────────────────────

function makeModel(responses: string[]): Model {
  let callIndex = 0;
  return {
    async *generate() {
      const text = responses[callIndex % responses.length] ?? "";
      callIndex++;
      yield { type: "text_delta", delta: text } as ModelEvent;
    },
  } as unknown as Model;
}

const nullWs: WorkspaceReader = {
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

const criterion = {
  id: "c1",
  description: "output is high quality",
  verify_method: "scalar_judge" as const,
};

// ── Score mode ────────────────────────────────────────────────────────────────

describe("ScalarLLMJudgeVerifier — score mode", () => {
  test("parseable score reply returns ok:true with score", async () => {
    const model = makeModel([
      '{"score": 8, "reasoning": "good"}',
      '{"score": 7, "reasoning": "decent"}',
      '{"score": 9, "reasoning": "excellent"}',
    ]);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 3 });
    const verdict = (await v.verify(criterion, nullWs)) as ScalarVerdict & { ok: true };
    expect(verdict.ok).toBe(true);
    expect(verdict.score).toBe(8); // mean(8,7,9)=8
    expect(typeof verdict.reasoning).toBe("string");
  });

  test("unparseable replies excluded from mean; all-unparseable → ok:false", async () => {
    const model = makeModel(["not json", "also not json", "nope"]);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 3 });
    const verdict = await v.verify(criterion, nullWs);
    expect(verdict.ok).toBe(false);
    expect((verdict as { hint: string }).hint).toContain("unparseable");
  });

  test("score clamped to 0-10 range; out-of-range reply excluded", async () => {
    const model = makeModel([
      '{"score": 15, "reasoning": "impossible"}',
      '{"score": 6, "reasoning": "ok"}',
      '{"score": 6, "reasoning": "ok2"}',
    ]);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 3 });
    const verdict = (await v.verify(criterion, nullWs)) as ScalarVerdict & { ok: true };
    expect(verdict.ok).toBe(true);
    expect(verdict.score).toBe(6); // only two valid votes, mean(6,6)=6
  });

  test("maxJudgeCallsPerBatch: samples exceeding cap get neutral score:5", async () => {
    const model = makeModel(['{"score": 10, "reasoning": "great"}']);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 3, maxJudgeCallsPerBatch: 2 });
    // First criterion uses 0 calls so far, 0+3 > 2 → skip immediately
    const verdict = (await v.verify(criterion, nullWs)) as ScalarVerdict & { ok: true };
    expect(verdict.ok).toBe(true);
    expect(verdict.score).toBe(5);
    expect(verdict.reasoning).toContain("skipped");
  });

  test("resetBatch() resets per-batch counter", async () => {
    const model = makeModel(['{"score": 9, "reasoning": "nice"}']);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 1, maxJudgeCallsPerBatch: 1 });
    // First verify uses the 1 allowed call
    await v.verify(criterion, nullWs);
    // Next would be skipped — reset first
    v.resetBatch();
    const verdict = (await v.verify(criterion, nullWs)) as ScalarVerdict & { ok: true };
    expect(verdict.ok).toBe(true);
    expect(verdict.score).toBe(9);
  });
});

// ── Pairwise mode ─────────────────────────────────────────────────────────────

describe("ScalarLLMJudgeVerifier — pairwise mode", () => {
  test("majority preference wins", async () => {
    const model = makeModel([
      '{"preferred": "a", "reasoning": "A is better"}',
      '{"preferred": "a", "reasoning": "A again"}',
      '{"preferred": "b", "reasoning": "B once"}',
    ]);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 3 });
    const result = await v.comparePair({
      criterionDescription: "quality",
      outputA: "output A text",
      outputB: "output B text",
    });
    expect(result.preferred).toBe("a");
  });

  test("unparseable response counted as tie", async () => {
    const model = makeModel(["not json", "not json", "not json"]);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 3 });
    const result = await v.comparePair({
      criterionDescription: "quality",
      outputA: "A",
      outputB: "B",
    });
    expect(result.preferred).toBe("tie");
  });

  test("tie when votes are split evenly", async () => {
    const model = makeModel([
      '{"preferred": "a", "reasoning": "A"}',
      '{"preferred": "b", "reasoning": "B"}',
    ]);
    const v = new ScalarLLMJudgeVerifier({ model, samples: 2 });
    const result = await v.comparePair({
      criterionDescription: "quality",
      outputA: "A",
      outputB: "B",
    });
    expect(result.preferred).toBe("tie");
  });
});
