import { describe, expect, it } from "vitest";
import {
  classifierGuardrail,
  denyTools,
  forbiddenPhrases,
  type InputGuardrail,
  maxInputLength,
  type OutputGuardrail,
  runInputGuardrails,
  runOutputGuardrails,
  runToolGuardrails,
  type ToolGuardrail,
} from "./index.js";

describe("maxInputLength guardrail", () => {
  it("passes when task is within limit", async () => {
    const g = maxInputLength(100);
    const result = await g.check("short task", []);
    expect(result.tripwireTriggered).toBe(false);
  });

  it("triggers tripwire when task exceeds limit", async () => {
    const g = maxInputLength(5);
    const result = await g.check("this is too long", []);
    expect(result.tripwireTriggered).toBe(true);
    expect(result.metadata?.length).toBeGreaterThan(5);
  });
});

describe("forbiddenPhrases guardrail", () => {
  it("passes when no forbidden phrases in answer", async () => {
    const g = forbiddenPhrases(["harmful", "dangerous"]);
    const result = await g.check("this is a safe answer");
    expect(result.tripwireTriggered).toBe(false);
  });

  it("triggers tripwire when forbidden phrase is present (case-insensitive)", async () => {
    const g = forbiddenPhrases(["harmful"]);
    const result = await g.check("This answer is HARMFUL to users");
    expect(result.tripwireTriggered).toBe(true);
    expect(result.metadata?.phrase).toBe("harmful");
  });

  it("works with object answers (serializes to JSON)", async () => {
    const g = forbiddenPhrases(["secret"]);
    const result = await g.check({ data: "contains secret info" });
    expect(result.tripwireTriggered).toBe(true);
  });
});

describe("denyTools guardrail", () => {
  it("passes for non-denied tools", async () => {
    const g = denyTools(["rm_file", "exec_shell"]);
    const result = await g.check("read_file", {});
    expect(result.tripwireTriggered).toBe(false);
  });

  it("triggers tripwire for denied tools", async () => {
    const g = denyTools(["rm_file", "exec_shell"]);
    const result = await g.check("exec_shell", { cmd: "rm -rf /" });
    expect(result.tripwireTriggered).toBe(true);
    expect(result.metadata?.toolName).toBe("exec_shell");
  });
});

describe("runInputGuardrails", () => {
  it("returns null when no guardrails", async () => {
    const result = await runInputGuardrails([], "task", []);
    expect(result).toBeNull();
  });

  it("returns null when all pass", async () => {
    const g = maxInputLength(100);
    const result = await runInputGuardrails([g], "short", []);
    expect(result).toBeNull();
  });

  it("returns tripwire info when one triggers", async () => {
    const g = maxInputLength(5);
    const result = await runInputGuardrails([g], "this is way too long", []);
    expect(result).not.toBeNull();
    expect(result?.guardrailName).toContain("maxInputLength");
    expect(result?.result.tripwireTriggered).toBe(true);
  });

  it("runs guardrails in parallel (both trigger, first wins)", async () => {
    const timings: string[] = [];
    const slow: InputGuardrail = {
      name: "slow",
      async check() {
        await new Promise((r) => setTimeout(r, 20));
        timings.push("slow");
        return { tripwireTriggered: true };
      },
    };
    const fast: InputGuardrail = {
      name: "fast",
      async check() {
        timings.push("fast");
        return { tripwireTriggered: true };
      },
    };
    const result = await runInputGuardrails([slow, fast], "task", []);
    // Both run concurrently; first in array order that triggers is returned
    expect(result?.guardrailName).toBe("slow");
    // fast completed before slow due to no-delay
    expect(timings).toContain("fast");
    expect(timings).toContain("slow");
  });
});

describe("runOutputGuardrails", () => {
  it("returns null when no guardrails", async () => {
    const result = await runOutputGuardrails([], "answer");
    expect(result).toBeNull();
  });

  it("triggers on forbidden phrase in output", async () => {
    const g = forbiddenPhrases(["badword"]);
    const result = await runOutputGuardrails([g], "this has badword in it");
    expect(result?.guardrailName).toBe("forbiddenPhrases");
  });
});

describe("runToolGuardrails", () => {
  it("returns null when no guardrails", async () => {
    const result = await runToolGuardrails([], "any_tool", {});
    expect(result).toBeNull();
  });

  it("triggers for denied tool", async () => {
    const g = denyTools(["dangerous_tool"]);
    const result = await runToolGuardrails([g], "dangerous_tool", {});
    expect(result?.guardrailName).toContain("denyTools");
  });

  it("passes for allowed tool", async () => {
    const g = denyTools(["dangerous_tool"]);
    const result = await runToolGuardrails([g], "safe_tool", {});
    expect(result).toBeNull();
  });
});

describe("ToolCallingAgent integration with guardrails", () => {
  // Integration tests that verify guardrails wire into the agent correctly
  // are in ToolCallingAgent.test.ts — here we test the guardrail primitives only.
  it("custom guardrail can be implemented as an object", async () => {
    const piiGuardrail: InputGuardrail = {
      name: "piiDetector",
      check(task) {
        const hasPii = /\b\d{3}-\d{2}-\d{4}\b/.test(task); // SSN pattern
        return { tripwireTriggered: hasPii, metadata: { reason: "ssn_detected" } };
      },
    };
    const result = await runInputGuardrails([piiGuardrail], "My SSN is 123-45-6789", []);
    expect(result?.guardrailName).toBe("piiDetector");
    expect(result?.result.metadata?.reason).toBe("ssn_detected");
  });

  it("async custom output guardrail works", async () => {
    const asyncGuardrail: OutputGuardrail = {
      name: "asyncCheck",
      async check(answer) {
        await new Promise((r) => setTimeout(r, 1));
        return { tripwireTriggered: String(answer).includes("forbidden") };
      },
    };
    const safe = await runOutputGuardrails([asyncGuardrail], "safe answer");
    expect(safe).toBeNull();
    const unsafe = await runOutputGuardrails([asyncGuardrail], "this is forbidden content");
    expect(unsafe?.guardrailName).toBe("asyncCheck");
  });

  it("custom tool guardrail receives toolName and input", async () => {
    let capturedToolName = "";
    let capturedInput: unknown = null;
    const spy: ToolGuardrail = {
      name: "spy",
      check(toolName, input) {
        capturedToolName = toolName;
        capturedInput = input;
        return { tripwireTriggered: false };
      },
    };
    await runToolGuardrails([spy], "my_tool", { key: "value" });
    expect(capturedToolName).toBe("my_tool");
    expect(capturedInput).toEqual({ key: "value" });
  });
});

describe("B1 — classifierGuardrail onError behavior", () => {
  function makeThrowingModel(): { generate: () => AsyncGenerator<never> } {
    return {
      // biome-ignore lint/correctness/useYield: test helper always throws
      async *generate() {
        throw new Error("classifier is down");
      },
    };
  }

  it("onError='open' (default): classifier error does NOT trigger tripwire", async () => {
    const g = classifierGuardrail({ model: makeThrowingModel() });
    const result = await g.check("some content");
    expect(result.tripwireTriggered).toBe(false);
    expect(result.metadata?.classifierError).toMatch(/classifier is down/);
  });

  it("onError='closed': classifier error triggers tripwire", async () => {
    const g = classifierGuardrail({ model: makeThrowingModel(), onError: "closed" });
    const result = await g.check("some content");
    expect(result.tripwireTriggered).toBe(true);
    expect(result.metadata?.classifierError).toMatch(/classifier is down/);
  });

  it("onError='open' explicit: same as default, does not block", async () => {
    const g = classifierGuardrail({ model: makeThrowingModel(), onError: "open" });
    const result = await g.check("some content");
    expect(result.tripwireTriggered).toBe(false);
  });

  it("non-error case: safe classifier response passes through regardless of onError", async () => {
    const safeModel = {
      async *generate(): AsyncGenerator<{ type: string; delta?: string }> {
        yield { type: "text_delta", delta: '{"safe": true}' };
      },
    };
    const g = classifierGuardrail({ model: safeModel, onError: "closed" });
    const result = await g.check("safe content");
    expect(result.tripwireTriggered).toBe(false);
  });
});
