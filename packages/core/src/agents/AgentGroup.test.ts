/**
 * AgentGroup — Milestone 6 multi-agent coordination + cross-linked evidence tests.
 *
 * The contract this file asserts:
 *   1. parallelism: members run concurrently (≪ serial baseline).
 *   2. cooperation: EVERY member contributes — there is no winner. The
 *      aggregated output and the evidence chain include all members.
 *   3. cross-linked evidence: every member shares one groupId, sees its
 *      siblings, and produces a contributionHash; the coordination record
 *      binds them via a digest that changes if any contribution changes.
 *   4. evidence-store integration: a real @wasmagent/aep EvidenceStore
 *      (duck-compatible) receives the coordination record.
 *   5. fault isolation: a failed member does not abort siblings and is still
 *      represented in the cross-linked chain.
 *   6. workspace isolation: members fork from base; sibling writes never leak.
 *   7. delegation/nesting: an inherited delegationChain reaches every member
 *      and the coordination record.
 */

import { InMemoryEvidenceStore } from "@wasmagent/aep";
import { MapKvBackend } from "../memory/MemoryTool.js";
import type { AgentEvent } from "../types/events.js";
import { openOrCreateRoot } from "../workspace/BranchableWorkspace.js";
import {
  AGENT_GROUP_COORDINATION_TYPE,
  AgentGroup,
  type AgentGroupCoordinationRecord,
  type AgentGroupMember,
  type AgentGroupSpawnContext,
  coordinationDigestFor,
} from "./AgentGroup.js";

// ── Fake agent factory ──────────────────────────────────────────────────────

interface FakeAgentSpec {
  label: string;
  /** Final answer string. */
  answer?: string;
  /** Emit an `error` event mid-run (vs. `final_answer`). */
  error?: string;
  /** ms to sleep before yielding final_answer (simulates work). */
  delayMs?: number;
  /** Side-effect: write a file through the supplied workspace. */
  writeFile?: { path: string; content: string };
}

/**
 * Build a fake member whose factory records the spawn context it received
 * into `capture` (so tests can assert groupId / siblings / delegationChain).
 */
function makeFakeMember(spec: FakeAgentSpec, capture?: AgentGroupSpawnContext[]): AgentGroupMember {
  return {
    label: spec.label,
    factory: (ctx) => {
      capture?.push(ctx);
      return {
        async *run(_taskArg, parentTraceId): AsyncGenerator<AgentEvent> {
          const base = { traceId: ctx.memberId, parentTraceId, timestampMs: 0 };
          yield {
            ...base,
            channel: "text" as const,
            event: "run_start" as const,
            data: { task: ctx.task },
          };

          if (spec.writeFile) {
            await ctx.workspace.write(spec.writeFile.path, spec.writeFile.content);
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
      };
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AgentGroup — construction", () => {
  it("rejects an empty members list", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    expect(
      () =>
        new AgentGroup({
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
        new AgentGroup({
          task: "x",
          model: {} as never,
          members: [makeFakeMember({ label: "same" }), makeFakeMember({ label: "same" })],
          baseWorkspace: root,
        })
    ).toThrow(/duplicate/);
  });
});

describe("AgentGroup — parallelism", () => {
  it("3 cooperating members finish in ≪ 60% of the serial baseline", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const group = new AgentGroup({
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
    const out = await group.run();
    const elapsed = performance.now() - t0;
    expect(out.results).toHaveLength(3);
    expect(out.results.every((r) => !r.error)).toBe(true);
    // Serial baseline = 240ms; 60% = 144ms. Parallel is bounded by the slowest
    // member (~80ms) + overhead — generous 130ms keeps the test stable on CI.
    expect(elapsed).toBeLessThan(130);
  });

  it("respects maxConcurrency by running in waves", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const group = new AgentGroup({
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
    await group.run();
    const elapsed = performance.now() - t0;
    // Two waves of two ⇒ ≥ 2 * 50ms; well under 4 * 50ms (serial).
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(190);
  });
});

describe("AgentGroup — cooperation (no winner)", () => {
  it("aggregated output and evidence chain include EVERY member", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const group = new AgentGroup({
      task: "build the thing together",
      model: {} as never,
      members: [
        makeFakeMember({ label: "frontend", answer: "ui" }),
        makeFakeMember({ label: "backend", answer: "api" }),
        makeFakeMember({ label: "tests", answer: "spec" }),
      ],
      baseWorkspace: root,
    });
    const out = await group.run();

    // Cooperation, not best-of-n: every contribution is kept and aggregated.
    expect(out.aggregatedContributions).toContain("[frontend] ui");
    expect(out.aggregatedContributions).toContain("[backend] api");
    expect(out.aggregatedContributions).toContain("[tests] spec");

    // The evidence chain has one link per member — no member is dropped.
    expect(out.evidenceChain).toHaveLength(3);
    expect(out.evidenceChain.map((l) => l.label).sort()).toEqual(["backend", "frontend", "tests"]);
    // Every member has a non-empty contribution hash (the per-branch link).
    expect(out.evidenceChain.every((l) => l.contributionHash.length === 64)).toBe(true);
  });

  it("honours a custom aggregator", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const group = new AgentGroup({
      task: "x",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", answer: "1" }),
        makeFakeMember({ label: "b", answer: "2" }),
      ],
      baseWorkspace: root,
      aggregator: (contributions) =>
        contributions
          .filter((r) => !r.error)
          .map((r) => String(r.finalAnswer))
          .join("+"),
    });
    const out = await group.run();
    expect(out.aggregatedContributions).toBe("1+2");
  });
});

describe("AgentGroup — cross-linked evidence chain", () => {
  it("stamps every member with the same groupId and the correct sibling set", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const captured: AgentGroupSpawnContext[] = [];
    const group = new AgentGroup({
      task: "x",
      groupId: "g-42",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a" }, captured),
        makeFakeMember({ label: "b" }, captured),
        makeFakeMember({ label: "c" }, captured),
      ],
      baseWorkspace: root,
    });
    await group.run();

    expect(captured).toHaveLength(3);
    // Same group id everywhere — the cross-link key.
    expect(captured.every((c) => c.groupId === "g-42")).toBe(true);
    // Member ids are namespaced by groupId.
    expect(captured.map((c) => c.memberId).sort()).toEqual(["g-42-m0", "g-42-m1", "g-42-m2"]);
    // Each member sees the other two as siblings (cross-reference material).
    expect(captured[0]?.siblingMemberIds.sort()).toEqual(["g-42-m1", "g-42-m2"]);
    expect(captured[1]?.siblingMemberIds.sort()).toEqual(["g-42-m0", "g-42-m2"]);
    expect(captured[2]?.siblingMemberIds.sort()).toEqual(["g-42-m0", "g-42-m1"]);
    // parentTraceId is the group trace, which defaults to the groupId.
    expect(captured.every((c) => c.parentTraceId === "g-42")).toBe(true);
  });

  it("coordination record binds all members; digest matches an independent recompute", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const group = new AgentGroup({
      task: "x",
      groupId: "g-bind",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", answer: "alpha" }),
        makeFakeMember({ label: "b", answer: "beta" }),
      ],
      baseWorkspace: root,
    });
    const out = await group.run();
    const rec = out.coordinationRecord;

    expect(rec.type).toBe(AGENT_GROUP_COORDINATION_TYPE);
    expect(rec.groupId).toBe("g-bind");
    expect(rec.memberLinks).toHaveLength(2);
    // memberLinks are sorted by memberId.
    expect(rec.memberLinks.map((l) => l.memberId)).toEqual(["g-bind-m0", "g-bind-m1"]);
    // The digest is reproducible from the cross-links alone — the auditor check.
    expect(rec.coordinationDigest).toBe(coordinationDigestFor("g-bind", out.evidenceChain));
    expect(out.coordinationDigest).toBe(rec.coordinationDigest);
  });

  it("digest changes when any member's contribution changes (tamper-evidence)", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const baseOpts = {
      task: "x",
      groupId: "g-tamper",
      model: {} as never,
      baseWorkspace: root,
    } as const;

    const out1 = await new AgentGroup({
      ...baseOpts,
      members: [
        makeFakeMember({ label: "a", answer: "v1" }),
        makeFakeMember({ label: "b", answer: "same" }),
      ],
    }).run();

    const out2 = await new AgentGroup({
      ...baseOpts,
      members: [
        makeFakeMember({ label: "a", answer: "v2" }),
        makeFakeMember({ label: "b", answer: "same" }),
      ],
    }).run();

    // b is unchanged, but a changed → the mutual-bind digest MUST change.
    expect(out1.coordinationDigest).not.toBe(out2.coordinationDigest);
    // And the unchanged member's own link is identical across both runs.
    const linkB1 = out1.evidenceChain.find((l) => l.label === "b");
    const linkB2 = out2.evidenceChain.find((l) => l.label === "b");
    expect(linkB1?.contributionHash).toBe(linkB2?.contributionHash);
    expect(linkB1?.contributionHash.length).toBe(64);
  });

  it("digest is stable across re-runs with identical contributions", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const build = () =>
      new AgentGroup({
        task: "x",
        groupId: "g-stable",
        model: {} as never,
        members: [
          makeFakeMember({ label: "a", answer: "z" }),
          makeFakeMember({ label: "b", answer: "y" }),
        ],
        baseWorkspace: root,
      });
    const out1 = await build().run();
    const out2 = await build().run();
    expect(out1.coordinationDigest).toBe(out2.coordinationDigest);
  });
});

describe("AgentGroup — evidence-store integration", () => {
  it("appends the coordination record to a real @wasmagent/aep EvidenceStore", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    // A genuine AEP in-memory store — structurally compatible with the
    // group's AgentGroupEvidenceSink (duck-typed append).
    const store = new InMemoryEvidenceStore();
    const group = new AgentGroup({
      task: "x",
      groupId: "g-store",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", answer: "1" }),
        makeFakeMember({ label: "b", answer: "2" }),
      ],
      baseWorkspace: root,
      evidenceStore: store,
    });
    const out = await group.run();

    expect(store.size()).toBe(1);
    const appended = store.all[0] as unknown as AgentGroupCoordinationRecord;
    expect(appended.type).toBe(AGENT_GROUP_COORDINATION_TYPE);
    expect(appended.groupId).toBe("g-store");
    expect(appended.coordinationDigest).toBe(out.coordinationDigest);
    expect(appended.memberLinks.map((l) => l.memberId)).toEqual(["g-store-m0", "g-store-m1"]);
  });
});

describe("AgentGroup — fault isolation", () => {
  it("a single failed member does not abort siblings and is still cross-linked", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const group = new AgentGroup({
      task: "x",
      groupId: "g-fault",
      model: {} as never,
      members: [
        makeFakeMember({ label: "ok", answer: "fine" }),
        makeFakeMember({ label: "boom", error: "oops" }),
        makeFakeMember({ label: "also-ok", answer: "fine2" }),
      ],
      baseWorkspace: root,
    });
    const out = await group.run();

    expect(out.results.map((r) => r.label)).toEqual(["ok", "boom", "also-ok"]);
    expect(out.results[1]?.error).toBe("oops");
    // The failed member still has a contribution hash so the chain binds it.
    expect(out.results[1]?.contributionHash.length).toBe(64);
    // And it still appears in the cross-linked evidence chain.
    expect(out.evidenceChain.find((l) => l.label === "boom")?.error).toBe("oops");
    // The successful members still contributed to the aggregated output.
    expect(out.aggregatedContributions).toContain("fine");
    expect(out.aggregatedContributions).toContain("fine2");
  });

  it("when every member fails, the coordination record still binds them all", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const group = new AgentGroup({
      task: "x",
      groupId: "g-allfail",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", error: "no" }),
        makeFakeMember({ label: "b", error: "nope" }),
      ],
      baseWorkspace: root,
    });
    const out = await group.run();
    expect(out.results.every((r) => r.error)).toBe(true);
    expect(out.evidenceChain).toHaveLength(2);
    expect(out.evidenceChain.every((l) => l.contributionHash.length === 64)).toBe(true);
    expect(out.coordinationRecord.memberLinks).toHaveLength(2);
    // Two distinct failures → two distinct contribution hashes.
    expect(out.evidenceChain[0]?.contributionHash).not.toBe(out.evidenceChain[1]?.contributionHash);
  });
});

describe("AgentGroup — workspace isolation", () => {
  it("members fork from baseWorkspace; sibling writes never leak", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("shared.ts", "v0");
    const group = new AgentGroup({
      task: "x",
      model: {} as never,
      members: [
        makeFakeMember({ label: "a", writeFile: { path: "shared.ts", content: "from-A" } }),
        makeFakeMember({ label: "b", writeFile: { path: "shared.ts", content: "from-B" } }),
      ],
      baseWorkspace: root,
    });
    const out = await group.run();

    // Base is untouched.
    expect(await root.read("shared.ts")).toBe("v0");
    // Each member's diff against base shows ONE modified file with its content.
    expect(out.results[0]?.workspaceChanges).toEqual([
      { path: "shared.ts", kind: "modified", content: "from-A" },
    ]);
    expect(out.results[1]?.workspaceChanges).toEqual([
      { path: "shared.ts", kind: "modified", content: "from-B" },
    ]);
  });
});

describe("AgentGroup — delegation / nesting", () => {
  it("an inherited delegationChain reaches every member and the coordination record", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const captured: AgentGroupSpawnContext[] = [];
    const group = new AgentGroup({
      task: "x",
      groupId: "g-child",
      traceId: "g-child-trace",
      delegationChain: ["parent-agent", "parent-group"],
      model: {} as never,
      members: [makeFakeMember({ label: "a" }, captured), makeFakeMember({ label: "b" }, captured)],
      baseWorkspace: root,
    });
    const out = await group.run();

    // Each member's chain = inherited ancestors + this group's trace id.
    expect(captured[0]?.delegationChain).toEqual(["parent-agent", "parent-group", "g-child-trace"]);
    expect(captured[1]?.delegationChain).toEqual(["parent-agent", "parent-group", "g-child-trace"]);
    // The coordination record carries the same chain for auditors.
    expect(out.coordinationRecord.delegationChain).toEqual([
      "parent-agent",
      "parent-group",
      "g-child-trace",
    ]);
  });
});

describe("AgentGroup — observability", () => {
  it("onEvent is called with member label + every emitted event in order", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const seen: Array<[string, string]> = [];
    const group = new AgentGroup({
      task: "x",
      model: {} as never,
      members: [makeFakeMember({ label: "obs" })],
      baseWorkspace: root,
      onEvent: (label, ev) => seen.push([label, ev.event]),
    });
    await group.run();
    expect(seen.map(([, ev]) => ev)).toEqual(["run_start", "final_answer"]);
    expect(seen.every(([l]) => l === "obs")).toBe(true);
  });
});
