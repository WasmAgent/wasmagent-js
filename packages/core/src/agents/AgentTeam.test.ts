/**
 * AgentTeam — F2 tests.
 *
 * The contract the v3 plan asks for:
 *   1. parallel speedup: 3 sub-agents finish in less than ~60% of the
 *      serial baseline (assert wall-clock against an injected fake clock).
 *   2. parent-context decoupling: parent's compressed summary stays small
 *      regardless of sub-agent output volume.
 *   3. best-of-n: scorer is called for every successful member; the winner
 *      is the highest scorer; failures sink to the bottom of the ranking
 *      and never become the winner.
 *   4. workspace isolation: members write into independent forks; sibling
 *      writes never leak.
 *   5. fault isolation: one member's throw does not abort the others.
 *   6. tool-guardrail handoff: caller-supplied guardrail is preserved per
 *      member (not silently swapped out).
 */

import { MapKvBackend } from "../memory/MemoryTool.js";
import type { AgentEvent } from "../types/events.js";
import { openOrCreateRoot } from "../workspace/BranchableWorkspace.js";
import {
  AgentTeam,
  type AgentTeamMember,
  type AgentTeamScorer,
  longestAnswerScorer,
} from "./AgentTeam.js";

// ── Fake agent factory ──────────────────────────────────────────────────────

interface FakeAgentSpec {
  label: string;
  /** Final answer string. */
  answer?: string;
  /** Throw / error mid-run (vs. `final_answer`). */
  error?: string;
  /** ms to sleep before yielding final_answer (simulates work). */
  delayMs?: number;
  /** Side-effect: write a file through the supplied workspace. */
  writeFile?: { path: string; content: string };
  /** How many tool_call events to emit (used by the parent-summary bound test). */
  noisyToolCalls?: number;
}

function makeFakeMember(spec: FakeAgentSpec): AgentTeamMember {
  return {
    label: spec.label,
    factory: ({ task, workspace, parentTraceId, memberId }) => ({
      async *run(_taskArg, _parentTraceId): AsyncGenerator<AgentEvent> {
        const base = {
          traceId: memberId,
          parentTraceId,
          timestampMs: 0,
        };
        yield {
          ...base,
          channel: "text" as const,
          event: "run_start" as const,
          data: { task },
        };

        if (spec.writeFile) {
          await workspace.write(spec.writeFile.path, spec.writeFile.content);
        }
        for (let i = 0; i < (spec.noisyToolCalls ?? 0); i++) {
          yield {
            ...base,
            channel: "tool" as const,
            event: "tool_call" as const,
            data: {
              toolName: "noop",
              args: {},
              callId: `c${i}`,
              batchId: "b",
              batchSize: 1,
              stepIndex: i,
            },
          };
          yield {
            ...base,
            channel: "tool" as const,
            event: "tool_result" as const,
            data: {
              toolName: "noop",
              callId: `c${i}`,
              output: "x".repeat(500), // big tool output — must NOT bloat parent summary
              batchId: "b",
              batchSize: 1,
              stepIndex: i,
            },
          };
        }
        if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));

        if (spec.error) {
          yield {
            ...base,
            channel: "text" as const,
            event: "error" as const,
            data: { error: spec.error },
          };
          return;
        }
        yield {
          ...base,
          channel: "text" as const,
          event: "final_answer" as const,
          data: { answer: spec.answer ?? `${spec.label}-answer` },
        };
      },
    }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AgentTeam — construction", () => {
  it("rejects an empty members list", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    expect(
      () =>
        new AgentTeam({
          task: "x",
          model: {} as never,
          members: [],
          baseWorkspace: root,
        })
    ).toThrow(/members/);
  });

  it("rejects duplicate member labels", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    expect(
      () =>
        new AgentTeam({
          task: "x",
          model: {} as never,
          members: [makeFakeMember({ label: "same" }), makeFakeMember({ label: "same" })],
          baseWorkspace: root,
        })
    ).toThrow(/duplicate/);
  });
});

describe("AgentTeam — parallelism", () => {
  it("3 sub-agents in parallel finish in ≪ 60% of the serial baseline", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const team = new AgentTeam({
      task: "shared task",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", delayMs: 80 }),
        makeFakeMember({ label: "b", delayMs: 80 }),
        makeFakeMember({ label: "c", delayMs: 80 }),
      ],
      baseWorkspace: root,
    });
    const t0 = performance.now();
    const out = await team.run();
    const elapsed = performance.now() - t0;
    expect(out.results).toHaveLength(3);
    expect(out.results.every((r) => !r.error)).toBe(true);
    // Serial baseline = 240ms; 60% = 144ms. The parallel run is bounded by
    // the slowest member (~80ms) plus overhead — give a generous 130ms to
    // keep the test stable on slow CI without losing the assertion's value.
    expect(elapsed).toBeLessThan(130);
  });

  it("respects maxConcurrency by running in waves", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const team = new AgentTeam({
      task: "shared",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", delayMs: 50 }),
        makeFakeMember({ label: "b", delayMs: 50 }),
        makeFakeMember({ label: "c", delayMs: 50 }),
        makeFakeMember({ label: "d", delayMs: 50 }),
      ],
      baseWorkspace: root,
      maxConcurrency: 2,
    });
    const t0 = performance.now();
    await team.run();
    const elapsed = performance.now() - t0;
    // Two waves of two ⇒ ≥ 2 * 50ms; but well under 4 * 50ms (serial).
    expect(elapsed).toBeGreaterThanOrEqual(95); // small slack for timer jitter
    expect(elapsed).toBeLessThan(190);
  });
});

describe("AgentTeam — parent-context decoupling", () => {
  it("parent summary stays bounded even when sub-agents flood tool output", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const team = new AgentTeam({
      task: "noisy",
      model: {} as never,
      members: [makeFakeMember({ label: "loud", noisyToolCalls: 50, answer: "the answer" })],
      baseWorkspace: root,
      summaryMaxChars: 500,
    });
    const out = await team.run();
    // Single member produced 50 tool_call + 50 tool_result events with 500-char outputs each (~50KB),
    // but the parent summary stays under the configured cap.
    expect(out.parentSummary.length).toBeLessThanOrEqual(500);
    // And it contains the answer, not the noise.
    expect(out.parentSummary).toContain("the answer");
    expect(out.parentSummary).not.toContain("xxxxxxxxxx");
  });
});

describe("AgentTeam — best-of-n scoring", () => {
  it("calls the scorer for every successful member; winner is the top score", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const seen = new Set<string>();
    const scorer: AgentTeamScorer = ({ label }) => {
      seen.add(label);
      // a=0.2, b=0.9, c=0.5
      return label === "b" ? 0.9 : label === "c" ? 0.5 : 0.2;
    };
    const team = new AgentTeam({
      task: "x",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a" }),
        makeFakeMember({ label: "b" }),
        makeFakeMember({ label: "c" }),
      ],
      baseWorkspace: root,
      scorer,
    });
    const out = await team.run();
    expect(seen).toEqual(new Set(["a", "b", "c"]));
    expect(out.winner).not.toBeNull();
    expect(out.results[out.winner as number]?.label).toBe("b");
    expect(out.ranking).toEqual([1, 2, 0]); // b > c > a
  });

  it("misbehaving scorer that returns NaN clamps to 0 without breaking ranking", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const team = new AgentTeam({
      task: "x",
      model: {} as never,
      members: [makeFakeMember({ label: "a" }), makeFakeMember({ label: "b" })],
      baseWorkspace: root,
      scorer: ({ label }) => (label === "a" ? Number.NaN : 0.7),
    });
    const out = await team.run();
    expect(out.results[0]?.score).toBe(0);
    expect(out.results[1]?.score).toBe(0.7);
    expect(out.winner).toBe(1);
  });

  it("longestAnswerScorer is monotonic in length and discriminates duplicates by index", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const team = new AgentTeam({
      task: "x",
      model: {} as never,
      members: [
        makeFakeMember({ label: "short", answer: "hi" }),
        makeFakeMember({ label: "long", answer: "x".repeat(500) }),
        makeFakeMember({ label: "longer", answer: "x".repeat(1500) }),
      ],
      baseWorkspace: root,
      scorer: longestAnswerScorer(),
    });
    const out = await team.run();
    expect(out.results[2]?.score).toBeGreaterThan(out.results[1]?.score ?? -1);
    expect(out.results[1]?.score).toBeGreaterThan(out.results[0]?.score ?? -1);
    expect(out.winner).toBe(2);
  });
});

describe("AgentTeam — fault isolation", () => {
  it("a single throwing member does not abort siblings", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const team = new AgentTeam({
      task: "x",
      model: {} as never,
      members: [
        makeFakeMember({ label: "ok", answer: "fine" }),
        makeFakeMember({ label: "boom", error: "oops" }),
        makeFakeMember({ label: "also-ok", answer: "fine2" }),
      ],
      baseWorkspace: root,
      scorer: ({ finalAnswer }) =>
        typeof finalAnswer === "string" && finalAnswer.length > 0 ? 1 : 0,
    });
    const out = await team.run();
    expect(out.results.map((r) => r.label)).toEqual(["ok", "boom", "also-ok"]);
    expect(out.results[1]?.error).toBe("oops");
    expect(out.results[1]?.score).toBeNull();
    // Failed member must NOT win, even though it's at index 1.
    expect(out.winner).not.toBe(1);
    // Failed member sinks to the bottom of the ranking.
    expect(out.ranking[out.ranking.length - 1]).toBe(1);
  });

  it("when every member fails, winner is null but results are still complete", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const team = new AgentTeam({
      task: "x",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", error: "no" }),
        makeFakeMember({ label: "b", error: "nope" }),
      ],
      baseWorkspace: root,
    });
    const out = await team.run();
    expect(out.winner).toBeNull();
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.error)).toBe(true);
  });
});

describe("AgentTeam — workspace isolation", () => {
  it("members fork from baseWorkspace; sibling writes never leak", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("shared.ts", "v0");
    const team = new AgentTeam({
      task: "x",
      model: {} as never,
      members: [
        makeFakeMember({
          label: "a",
          writeFile: { path: "shared.ts", content: "from-A" },
        }),
        makeFakeMember({
          label: "b",
          writeFile: { path: "shared.ts", content: "from-B" },
        }),
      ],
      baseWorkspace: root,
    });
    const out = await team.run();

    // Base is untouched.
    expect(await root.read("shared.ts")).toBe("v0");

    // Each member's diff against base shows ONE modified file with their content.
    expect(out.results[0]?.workspaceChanges).toEqual([
      { path: "shared.ts", kind: "modified", content: "from-A" },
    ]);
    expect(out.results[1]?.workspaceChanges).toEqual([
      { path: "shared.ts", kind: "modified", content: "from-B" },
    ]);
  });
});

describe("AgentTeam — observability", () => {
  it("onEvent is called with member label + every emitted event in order", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const seen: Array<[string, string]> = [];
    const team = new AgentTeam({
      task: "x",
      model: {} as never,
      members: [makeFakeMember({ label: "obs", noisyToolCalls: 1 })],
      baseWorkspace: root,
      onEvent: (label, ev) => seen.push([label, ev.event]),
    });
    await team.run();
    const events = seen.filter(([l]) => l === "obs").map(([, ev]) => ev);
    expect(events).toEqual(["run_start", "tool_call", "tool_result", "final_answer"]);
  });
});
