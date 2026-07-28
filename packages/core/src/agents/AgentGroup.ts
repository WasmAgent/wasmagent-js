/**
 * AgentGroup — Milestone 6 multi-agent coordination primitive with
 * cross-linked evidence chains.
 *
 * {@link AgentTeam} (F2) runs N members as **competitors** on one task and
 * returns a single best-of-n winner. `AgentGroup` runs N members as
 * **cooperators** on a shared task: every member's contribution is kept,
 * contributions are aggregated, and — the defining feature — the members'
 * evidence chains are **cross-linked** so an auditor can prove the parallel
 * runs are bound together.
 *
 * ## Cross-linked evidence chain
 *
 *   1. Every member shares a stable `groupId` (the cross-link key), stamped
 *      into each member's {@link AgentGroupSpawnContext} so members can
 *      attribute their own evidence (AEP delegation chain, run_context) to
 *      the group.
 *   2. Each member's run produces a `contributionHash` — SHA-256 over its
 *      final answer plus a stable fingerprint of its event stream.
 *   3. After all members finish, the group mints a coordination record that
 *      references every member's `(memberId, traceId, contributionHash)` and
 *      carries a `coordinationDigest` = SHA-256 over the canonical
 *      `(groupId, sorted member links)`. This digest is the mutual bind: any
 *      change to any member's contribution (or to the membership itself)
 *      changes the coordination digest, so the parallel chains cannot be
 *      silently severed, reordered, or substituted.
 *   4. When an `evidenceStore` is supplied, the coordination record is
 *      appended to it, placing the cross-link into the durable chain.
 *
 * ## Dependency boundary
 *
 * The store is accepted via a structural interface
 * ({@link AgentGroupEvidenceSink}, duck-compatible with `@wasmagent/aep`'s
 * `EvidenceStore` — which appends arbitrary records) so `AgentGroup` carries
 * **zero runtime dependency** on the evidence layer, mirroring `AgentTeam`'s
 * dependency boundary. Hashing uses only `node:crypto`.
 *
 * ## What ships in this file
 *
 *   - {@link AgentGroup} — the orchestrator
 *   - {@link AgentGroupMember} / {@link AgentGroupSpawnContext} — inputs
 *   - {@link AgentGroupResult} — per-member outputs + the cross-linked
 *     evidence chain + the coordination record
 *   - {@link coordinationDigestFor} — recompute the mutual-bind digest (used
 *     by verifiers/auditors and by tests)
 */

import { createHash } from "node:crypto";
import type { ToolGuardrail } from "../guardrails/index.js";
import type { Model } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../types/events.js";
import type { BranchableWorkspace } from "../workspace/BranchableWorkspace.js";
import type { SubagentRunnable } from "./Subagent.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Inputs the group passes to a member's factory at spawn time. Superset of
 * {@link AgentTeamSpawnContext} — adds the group coordination fields members
 * need to cross-link their own evidence.
 */
export interface AgentGroupSpawnContext {
  /** The group's shared task as the parent stated it; the factory may rewrite it. */
  task: string;
  /** Model preference for this member; may be the same across all members. */
  model: Model;
  /** Tools the member is allowed to call. Pre-filtered by ToolGuardrail. */
  tools: ToolDefinition[];
  /** Member-private workspace fork. Already initialised; safe to write to. */
  workspace: BranchableWorkspace;
  /** Stable id ("group-<groupId>-m<index>") for logging / event correlation. */
  memberId: string;
  /** This member's parent traceId — the group's traceId. Emit events with parentTraceId = this. */
  parentTraceId: string | null;
  /**
   * AEP delegation chain for the member. Contains all ancestor agent IDs
   * including this group's traceId. Use to populate AEP
   * run_context.delegation_chain so the member's evidence links back to the
   * group (and any ancestor group).
   */
  delegationChain: string[];
  /**
   * Group coordination id — the cross-link key shared by every member.
   * Members stamp this into their evidence (e.g. AEP run_context.session_id)
   * so all member records can be grouped post-hoc.
   */
  groupId: string;
  /**
   * Stable ids of this member's siblings (every other member). Lets a member
   * cross-reference sibling runs in its own evidence if it emits AEP records.
   */
  siblingMemberIds: string[];
}

/** Caller-supplied factory: turn a spawn context into a runnable agent. */
export type AgentGroupFactory = (ctx: AgentGroupSpawnContext) => SubagentRunnable;

export interface AgentGroupMember {
  /** Stable label surfaced in logs and the coordination record. */
  label: string;
  /**
   * Optional task override — if set, this member sees this task instead of
   * the group's shared `task`. Use for divide-and-conquer patterns where each
   * member owns a slice of the shared task.
   */
  taskOverride?: string;
  /** Member-specific tool whitelist; takes precedence over group tools. */
  tools?: ToolDefinition[];
  /** Member-specific model; falls back to the group's model when absent. */
  model?: Model;
  /** Factory that builds the runnable agent. Required. */
  factory: AgentGroupFactory;
}

export interface AgentGroupMemberResult {
  label: string;
  memberId: string;
  /** This member's traceId (=== memberId); every member's parentTraceId is the group traceId. */
  traceId: string;
  /** Final answer the member produced, or null on error. */
  finalAnswer: unknown;
  /** Compressed event tail — bounded length, for human inspection. */
  summary: string;
  /** All events the member emitted, in order. */
  events: AgentEvent[];
  /** Diff produced by the member against the group's base workspace. */
  workspaceChanges: Awaited<ReturnType<BranchableWorkspace["diff"]>>;
  /**
   * SHA-256 hex of this member's contribution — the per-branch evidence link.
   * Non-empty even for failed members (hash of the error), so the
   * coordination digest always binds the full membership.
   */
  contributionHash: string;
  /** Error message if the member failed, else null. */
  error: string | null;
}

/**
 * One entry in the cross-linked evidence chain — the projection of a member's
 * result that participates in the coordination digest.
 */
export interface AgentGroupEvidenceLink {
  memberId: string;
  label: string;
  traceId: string;
  contributionHash: string;
  error: string | null;
}

/**
 * Coordination record binding every member's evidence chain into one root.
 *
 * This is the "cross-link": a single tamper-evident structure whose
 * {@link coordinationDigest} covers every member's contribution hash. Append
 * it to an {@link AgentGroupEvidenceSink} (e.g. an `@wasmagent/aep`
 * `EvidenceStore`) to place the cross-link into the durable chain.
 */
export interface AgentGroupCoordinationRecord {
  /** Discriminator identifying this as a group coordination record. */
  type: typeof AGENT_GROUP_COORDINATION_TYPE;
  /** The cross-link key shared by every member. */
  groupId: string;
  /** Group trace id; every member's parentTraceId === this. */
  traceId: string;
  /** The shared task the group coordinated on. */
  task: string;
  /** Delegation chain inherited by every member (parent → ... → group). */
  delegationChain: string[];
  /** One cross-link per member, sorted by memberId. */
  memberLinks: AgentGroupEvidenceLink[];
  created_at_ms: number;
  /**
   * SHA-256 over the canonical serialization of
   * `{ groupId, members: [{ contributionHash, memberId }] }` (memberLinks
   * sorted by memberId). Recompute with {@link coordinationDigestFor}.
   * Any change to any member's contribution (or to membership) changes this.
   */
  coordinationDigest: string;
}

export interface AgentGroupResult {
  /** The cross-link key shared by every member. */
  groupId: string;
  /** The group's trace id (parent of every member). */
  traceId: string;
  /** Per-member results in member order. Failed members have `.error` set. */
  results: AgentGroupMemberResult[];
  /** Cross-link view: one {@link AgentGroupEvidenceLink} per member. */
  evidenceChain: AgentGroupEvidenceLink[];
  /** The coordination record binding the chains together. */
  coordinationRecord: AgentGroupCoordinationRecord;
  /** Convenience accessor === coordinationRecord.coordinationDigest. */
  coordinationDigest: string;
  /**
   * Aggregated cooperation output — every member contributes (there is NO
   * winner; that is what distinguishes a group from a team). Built by the
   * optional `aggregator`, or the default concatenation in member order.
   */
  aggregatedContributions: string;
}

/**
 * Structural append-only sink. Duck-compatible with `@wasmagent/aep`'s
 * `EvidenceStore` (whose `append(record)` accepts any record and pushes it),
 * so a real `InMemoryEvidenceStore` / `FilesystemEvidenceStore` can be passed
 * directly. Declared with `unknown` so the assignment compiles regardless of
 * the concrete store's record type — and so `AgentGroup` has no runtime
 * dependency on `@wasmagent/aep`.
 */
export interface AgentGroupEvidenceSink {
  /** Append a coordination record to the durable evidence chain. */
  append(record: unknown): void | Promise<void>;
}

export interface AgentGroupOptions {
  /** The shared task every member coordinates on (unless overridden per member). */
  task: string;
  /** Default model used by every member that doesn't specify one. */
  model: Model;
  /** Default tool whitelist used by every member that doesn't specify one. */
  tools?: ToolDefinition[];
  /**
   * Tool guardrail applied to the group's default tool whitelist. Each member
   * also gets this guardrail unless it overrides tools. Reuses
   * {@link ToolGuardrail} verbatim — AgentGroup does not invent a new
   * permission system.
   */
  toolGuardrail?: ToolGuardrail;
  /** Members in order. At least one is required. */
  members: AgentGroupMember[];
  /** The base branch every member forks from. */
  baseWorkspace: BranchableWorkspace;
  /**
   * Optional concurrency cap. When members.length > maxConcurrency we run in
   * waves; default is unlimited (every member starts at the same time).
   */
  maxConcurrency?: number;
  /**
   * Group coordination id (the cross-link key). Auto-generated if omitted.
   * Surfaced into each member's spawn context and the coordination record.
   */
  groupId?: string;
  /** Stable group trace id; used to namespace member ids. Defaults to groupId. */
  traceId?: string;
  /**
   * AEP delegation chain — list of ancestor agent IDs that led to this group
   * being spawned (e.g. a parent agent or parent group). When set, the group
   * appends its own traceId before passing the chain down to each member's
   * {@link AgentGroupSpawnContext}. Maps directly to AEP
   * run_context.delegation_chain, enabling nested groups.
   */
  delegationChain?: string[];
  /** Optional per-event observer; called with every event from every member. */
  onEvent?: (memberLabel: string, event: AgentEvent) => void;
  /**
   * Optional evidence store. When provided, `run()` appends the coordination
   * record, placing the cross-link into the durable chain. Structurally
   * compatible with `@wasmagent/aep`'s `EvidenceStore`.
   */
  evidenceStore?: AgentGroupEvidenceSink;
  /**
   * Cooperation aggregator: combines all member contributions into one
   * coordinated output. Default concatenates non-error answers in member
   * order. Unlike {@link AgentTeam}, there is NO scorer / winner — every
   * member contributes.
   */
  aggregator?: (contributions: AgentGroupMemberResult[]) => string;
}

// ── Implementation ───────────────────────────────────────────────────────────

/** Discriminator for {@link AgentGroupCoordinationRecord}. */
export const AGENT_GROUP_COORDINATION_TYPE = "aep-agent-group-coordination/v0.1";

const SUMMARY_TAIL_EVENTS = 6;

export class AgentGroup {
  readonly #opts: Required<
    Omit<
      AgentGroupOptions,
      | "tools"
      | "toolGuardrail"
      | "maxConcurrency"
      | "onEvent"
      | "evidenceStore"
      | "aggregator"
      | "delegationChain"
      | "traceId"
      | "groupId"
    >
  > & {
    tools: ToolDefinition[] | undefined;
    toolGuardrail: ToolGuardrail | undefined;
    maxConcurrency: number | undefined;
    onEvent: ((memberLabel: string, event: AgentEvent) => void) | undefined;
    evidenceStore: AgentGroupEvidenceSink | undefined;
    aggregator: ((contributions: AgentGroupMemberResult[]) => string) | undefined;
    delegationChain: string[] | undefined;
    traceId: string;
    groupId: string;
  };

  constructor(opts: AgentGroupOptions) {
    if (!opts.members.length) {
      throw new Error("AgentGroup: members[] must be non-empty");
    }
    const labels = new Set<string>();
    for (const m of opts.members) {
      if (labels.has(m.label)) {
        throw new Error(`AgentGroup: duplicate member label ${JSON.stringify(m.label)}`);
      }
      labels.add(m.label);
    }
    const groupId = opts.groupId ?? `group-${randomSuffix()}`;
    this.#opts = {
      task: opts.task,
      model: opts.model,
      tools: opts.tools,
      toolGuardrail: opts.toolGuardrail,
      members: opts.members,
      baseWorkspace: opts.baseWorkspace,
      maxConcurrency: opts.maxConcurrency,
      groupId,
      traceId: opts.traceId ?? groupId,
      delegationChain: opts.delegationChain,
      onEvent: opts.onEvent,
      evidenceStore: opts.evidenceStore,
      aggregator: opts.aggregator,
    };
  }

  /** Run the group, returning per-member results plus the cross-linked evidence chain. */
  async run(): Promise<AgentGroupResult> {
    const concurrency = this.#opts.maxConcurrency ?? this.#opts.members.length;
    const siblingIds = this.#opts.members.map((_m, i) => this.#memberId(i));
    const results: AgentGroupMemberResult[] = new Array(this.#opts.members.length);

    // Run in waves capped at `concurrency`. One member's failure does not
    // abort siblings — failures are reported in results[i].error and the
    // surviving members still contribute to the aggregated output and the
    // coordination record.
    const queue = this.#opts.members.map((m, i) => ({ m, i }));
    while (queue.length) {
      const wave = queue.splice(0, concurrency);
      const settled = await Promise.all(
        wave.map(({ m, i }) =>
          this.#runMember(m, i, siblingIds).catch(
            (err): AgentGroupMemberResult => ({
              label: m.label,
              memberId: this.#memberId(i),
              traceId: this.#memberId(i),
              finalAnswer: null,
              summary: "",
              events: [],
              workspaceChanges: [],
              contributionHash: hashContribution(
                null,
                [],
                err instanceof Error ? err.message : String(err)
              ),
              error: err instanceof Error ? err.message : String(err),
            })
          )
        )
      );
      for (let j = 0; j < wave.length; j++) {
        const idx = wave[j]?.i;
        const r = settled[j];
        if (idx !== undefined && r) results[idx] = r;
      }
    }

    const evidenceChain: AgentGroupEvidenceLink[] = results.map((r) => ({
      memberId: r.memberId,
      label: r.label,
      traceId: r.traceId,
      contributionHash: r.contributionHash,
      error: r.error,
    }));

    const coordinationRecord = this.#buildCoordinationRecord(evidenceChain);
    const aggregatedContributions = (this.#opts.aggregator ?? defaultAggregator)(results);

    if (this.#opts.evidenceStore) {
      // Place the cross-link into the durable chain. Swallow append errors so
      // a flaky store never loses the in-memory coordination record / result;
      // persistence is best-effort relative to orchestration.
      try {
        await this.#opts.evidenceStore.append(coordinationRecord);
      } catch {
        /* best-effort — result still carries the coordination record */
      }
    }

    return {
      groupId: this.#opts.groupId,
      traceId: this.#opts.traceId,
      results,
      evidenceChain,
      coordinationRecord,
      coordinationDigest: coordinationRecord.coordinationDigest,
      aggregatedContributions,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #memberId(i: number): string {
    return `${this.#opts.groupId}-m${i}`;
  }

  async #runMember(
    member: AgentGroupMember,
    index: number,
    siblingIds: string[]
  ): Promise<AgentGroupMemberResult> {
    const memberId = this.#memberId(index);
    const fork = await this.#opts.baseWorkspace.fork(memberId);
    const tools = member.tools ?? this.#opts.tools ?? [];
    const siblings = siblingIds.filter((id) => id !== memberId);
    const ctx: AgentGroupSpawnContext = {
      task: member.taskOverride ?? this.#opts.task,
      model: member.model ?? this.#opts.model,
      tools,
      workspace: fork,
      memberId,
      parentTraceId: this.#opts.traceId,
      delegationChain: [...(this.#opts.delegationChain ?? []), this.#opts.traceId],
      groupId: this.#opts.groupId,
      siblingMemberIds: siblings,
    };
    const agent = member.factory(ctx);

    const events: AgentEvent[] = [];
    let finalAnswer: unknown = null;
    let errorMessage: string | null = null;

    for await (const ev of agent.run(ctx.task, this.#opts.traceId)) {
      events.push(ev);
      this.#opts.onEvent?.(member.label, ev);
      if (ev.event === "final_answer") {
        finalAnswer = ev.data.answer;
      } else if (ev.event === "error") {
        errorMessage = ev.data.error;
      }
    }

    const workspaceChanges = await fork.diff(this.#opts.baseWorkspace);

    return {
      label: member.label,
      memberId,
      traceId: memberId,
      finalAnswer,
      summary: summariseEvents(events, finalAnswer, errorMessage),
      events,
      workspaceChanges,
      contributionHash: hashContribution(finalAnswer, events, errorMessage),
      error: errorMessage,
    };
  }

  #buildCoordinationRecord(links: AgentGroupEvidenceLink[]): AgentGroupCoordinationRecord {
    const sortedLinks = [...links].sort(byMemberId);
    return {
      type: AGENT_GROUP_COORDINATION_TYPE,
      groupId: this.#opts.groupId,
      traceId: this.#opts.traceId,
      task: this.#opts.task,
      delegationChain: [...(this.#opts.delegationChain ?? []), this.#opts.traceId],
      memberLinks: sortedLinks,
      created_at_ms: Date.now(),
      coordinationDigest: coordinationDigestFor(this.#opts.groupId, sortedLinks),
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recompute the coordination digest — the mutual bind over every member's
 * contribution. The canonical form is sorted-key JSON of
 * `{ groupId, members: [{ contributionHash, memberId }] }` with `members`
 * sorted by `memberId`. Only `memberId` + `contributionHash` participate
 * (label / traceId are display-only), so renaming a member's label or
 * reordering the input does not change the digest unless a contribution
 * actually changed.
 *
 * Auditors call this to verify a coordination record: recompute over the
 * record's `memberLinks` and compare to `record.coordinationDigest`.
 */
export function coordinationDigestFor(
  groupId: string,
  links: ReadonlyArray<AgentGroupEvidenceLink>
): string {
  const sorted = [...links].sort(byMemberId);
  // Fixed key order (alphabetical) → deterministic JSON.stringify.
  const canon = JSON.stringify({
    groupId,
    members: sorted.map((l) => ({ contributionHash: l.contributionHash, memberId: l.memberId })),
  });
  return sha256Hex(canon);
}

/**
 * SHA-256 hex of a member's contribution. Success: hash over the final answer
 * plus a stable event fingerprint. Failure: hash over the error message. The
 * fingerprint includes tool names (not full outputs) so legitimate large tool
 * results do not collide, while still discriminating different action traces.
 */
function hashContribution(
  finalAnswer: unknown,
  events: ReadonlyArray<AgentEvent>,
  error: string | null
): string {
  if (error) {
    return sha256Hex(`error:${error}`);
  }
  const ans = typeof finalAnswer === "string" ? finalAnswer : stableStringify(finalAnswer);
  const fp = events
    .map((e) =>
      e.event === "tool_call" || e.event === "tool_result"
        ? `${e.event}:${e.data.toolName}`
        : e.event
    )
    .join(",");
  return sha256Hex(`ans:${ans}|events:${fp}`);
}

/** Default cooperation aggregator: concatenate non-error answers in member order. */
function defaultAggregator(results: ReadonlyArray<AgentGroupMemberResult>): string {
  const parts: string[] = [];
  for (const r of results) {
    if (r.error) continue;
    const ans = typeof r.finalAnswer === "string" ? r.finalAnswer : stableStringify(r.finalAnswer);
    if (ans) parts.push(`[${r.label}] ${ans}`);
  }
  return parts.join("\n");
}

/** Compress events down to a short, bounded string for human inspection. */
function summariseEvents(
  events: ReadonlyArray<AgentEvent>,
  finalAnswer: unknown,
  error: string | null
): string {
  if (error) return `error: ${error.slice(0, 240)}`;
  const tail = events.slice(-SUMMARY_TAIL_EVENTS);
  const lines: string[] = [];
  for (const ev of tail) {
    switch (ev.event) {
      case "tool_call":
        lines.push(`→ ${ev.data.toolName}`);
        break;
      case "tool_result":
        lines.push(`← ${ev.data.toolName}${ev.data.error ? " ERR" : ""}`);
        break;
      case "final_answer": {
        const a =
          typeof ev.data.answer === "string" ? ev.data.answer : stableStringify(ev.data.answer);
        lines.push(`final: ${a?.slice(0, 200) ?? ""}`);
        break;
      }
      default:
        break;
    }
  }
  if (!lines.length && finalAnswer != null) {
    const a = typeof finalAnswer === "string" ? finalAnswer : stableStringify(finalAnswer);
    lines.push(`final: ${a.slice(0, 200)}`);
  }
  return lines.join("\n");
}

function byMemberId(a: AgentGroupEvidenceLink, b: AgentGroupEvidenceLink): number {
  if (a.memberId < b.memberId) return -1;
  if (a.memberId > b.memberId) return 1;
  return 0;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic JSON (sorted keys) so object key order never affects a hash. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 1e9).toString(36);
}
