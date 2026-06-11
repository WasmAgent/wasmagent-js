/**
 * AgentTeam — F2: parallel sub-agent orchestration with isolation + best-of-n.
 *
 * The shape that 2026 coding agents converged on (Claude Agent SDK Task,
 * Cursor 3 Subagents) is:
 *   - the parent decides "I want N specialists / N attempts"
 *   - each runs in its own context window (so the parent doesn't get
 *     drowned in tool output)
 *   - each runs in its own filesystem view (so they can't trample each
 *     other) — supplied here by F3's BranchableWorkspace
 *   - results are scored, and the winner (or a synthesis of the winners)
 *     comes back to the parent
 *
 * AgentTeam is the small primitive that wires those four together. It does
 * NOT define how a sub-agent decides to delegate — that's still up to the
 * parent's prompt / tool selection. It only handles the fan-out + isolation
 * + scoring + return.
 *
 * ## What ships in this file
 *
 *   - {@link AgentTeam} — the orchestrator
 *   - {@link AgentTeamMember} — what callers pass in (one per parallel run)
 *   - {@link AgentTeamResult} — what comes back (per-member outputs, scores,
 *     compressed summary, optional winner)
 *
 * ## Isolation guarantees (asserted by tests)
 *
 *   1. Each member's `BranchableWorkspace` is a fresh fork of the team's
 *      base branch — siblings cannot see each other's writes.
 *   2. Each member runs through its own caller-provided agent factory, so
 *      contexts (memory, message history, tool guardrails) are independent.
 *      The team does NOT mutate any agent the caller passes in.
 *   3. Members run truly concurrently via `Promise.all`; one member's failure
 *      does not abort siblings — failures are reported in `results[i].error`
 *      and the surviving members are still scored & returned.
 *
 * ## Scoring & best-of-n
 *
 * The team accepts an optional `scorer` (typically {@link runJudgeScorer}
 * with a domain rubric, or a custom function). When supplied, the result
 * carries a `winner` index and a sorted `ranking`. When omitted, the
 * caller can still do its own ranking from `results`.
 *
 * The compressed parent-context payload is bounded to a small string
 * (configurable via `summaryMaxChars`) so it CAN be inlined into the parent's
 * MessageAssembler without bloating its prompt — that's what enables the
 * "father agent's context is decoupled from sub-agent output size" property.
 */

import type { ToolGuardrail } from "../guardrails/index.js";
import type { Model } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../types/events.js";
import type { BranchableWorkspace } from "../workspace/BranchableWorkspace.js";
import type { SubagentRunnable } from "./Subagent.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Inputs the team passes to a member's factory at spawn time. The factory
 * is responsible for assembling these into an agent — typically a
 * ToolCallingAgent or CodeAgent. Keeping the factory caller-supplied means
 * F2 doesn't lock in a single agent class.
 */
export interface AgentTeamSpawnContext {
  /** The team's task as the parent stated it; the factory may rewrite it. */
  task: string;
  /** Model preference for this member; may be the same across all members. */
  model: Model;
  /** Tools the member is allowed to call. Pre-filtered by ToolGuardrail. */
  tools: ToolDefinition[];
  /** Member-private workspace fork. Already initialised; safe to write to. */
  workspace: BranchableWorkspace;
  /** Stable id ("team-<traceId>-m<index>") for logging / event correlation. */
  memberId: string;
  /** This member's parent traceId — emit events with parentTraceId = this. */
  parentTraceId: string | null;
}

/** Caller-supplied factory: turn a spawn context into a runnable agent. */
export type AgentTeamFactory = (ctx: AgentTeamSpawnContext) => SubagentRunnable;

export interface AgentTeamMember {
  /** Stable label surfaced in logs and ranking output. */
  label: string;
  /**
   * Optional task override — if set, this member sees this task instead of
   * the team's shared `task`. Use for "diverse perspectives" patterns where
   * each member tackles the same problem from a different angle.
   */
  taskOverride?: string;
  /** Member-specific tool whitelist; takes precedence over team tools. */
  tools?: ToolDefinition[];
  /** Member-specific model; falls back to the team's model when absent. */
  model?: Model;
  /** Factory that builds the runnable agent. Required. */
  factory: AgentTeamFactory;
}

export interface AgentTeamScorerInput {
  label: string;
  memberId: string;
  /** Final answer the member produced, or null on error. */
  finalAnswer: unknown;
  /** All events the member emitted, in order. */
  events: AgentEvent[];
  /** Diff produced by the member against the team's base workspace. */
  workspaceChanges: Awaited<ReturnType<BranchableWorkspace["diff"]>>;
}

/**
 * Optional scorer. Returns a number in [0, 1]. The team picks the highest
 * scorer as the winner; ties resolve to the lowest index (stable). Scorers
 * may be async (e.g. an LLM judge) and run in parallel across members.
 */
export type AgentTeamScorer = (input: AgentTeamScorerInput) => Promise<number> | number;

export interface AgentTeamMemberResult {
  label: string;
  memberId: string;
  finalAnswer: unknown;
  /** Compressed event tail (last few significant events) — bounded length. */
  summary: string;
  events: AgentEvent[];
  workspaceChanges: Awaited<ReturnType<BranchableWorkspace["diff"]>>;
  score: number | null;
  error: string | null;
}

export interface AgentTeamResult {
  results: AgentTeamMemberResult[];
  /** Index of the highest-scoring successful member, or null. */
  winner: number | null;
  /** Members sorted descending by score; failed members come last. */
  ranking: number[];
  /**
   * Bounded summary the parent can inject into its MessageAssembler. Includes
   * the winner's answer plus a one-line take from each runner-up. Trimmed
   * to `summaryMaxChars`.
   */
  parentSummary: string;
}

export interface AgentTeamOptions {
  /** Default task; per-member overrides win. */
  task: string;
  /** Default model used by every member that doesn't specify one. */
  model: Model;
  /** Default tool whitelist used by every member that doesn't specify one. */
  tools?: ToolDefinition[];
  /**
   * Tool guardrail applied to the team's default tool whitelist. Each member
   * also gets this guardrail unless it overrides tools. Reuses
   * {@link ToolGuardrail} verbatim — F2 explicitly does not invent a new
   * permission system.
   */
  toolGuardrail?: ToolGuardrail;
  /** Members in order. At least one is required. */
  members: AgentTeamMember[];
  /** The base branch every member forks from. */
  baseWorkspace: BranchableWorkspace;
  /** Optional scorer for best-of-n. */
  scorer?: AgentTeamScorer;
  /**
   * Optional concurrency cap. When members.length > maxConcurrency we run
   * in waves; default is unlimited (every member starts at the same time).
   */
  maxConcurrency?: number;
  /** Maximum length of `parentSummary`. Default 1500. */
  summaryMaxChars?: number;
  /** Stable team trace id; used to namespace member ids. */
  traceId?: string;
  /** Optional per-event observer; called with every event from every member. */
  onEvent?: (memberLabel: string, event: AgentEvent) => void;
}

// ── Implementation ───────────────────────────────────────────────────────────

const DEFAULT_SUMMARY_MAX = 1500;
const SUMMARY_TAIL_EVENTS = 6;

export class AgentTeam {
  readonly #opts: Required<
    Omit<AgentTeamOptions, "tools" | "toolGuardrail" | "scorer" | "maxConcurrency" | "onEvent">
  > & {
    tools: ToolDefinition[] | undefined;
    toolGuardrail: ToolGuardrail | undefined;
    scorer: AgentTeamScorer | undefined;
    maxConcurrency: number | undefined;
    onEvent: ((memberLabel: string, event: AgentEvent) => void) | undefined;
  };

  constructor(opts: AgentTeamOptions) {
    if (!opts.members.length) {
      throw new Error("AgentTeam: members[] must be non-empty");
    }
    const labels = new Set<string>();
    for (const m of opts.members) {
      if (labels.has(m.label)) {
        throw new Error(`AgentTeam: duplicate member label ${JSON.stringify(m.label)}`);
      }
      labels.add(m.label);
    }
    this.#opts = {
      task: opts.task,
      model: opts.model,
      tools: opts.tools,
      toolGuardrail: opts.toolGuardrail,
      members: opts.members,
      baseWorkspace: opts.baseWorkspace,
      scorer: opts.scorer,
      maxConcurrency: opts.maxConcurrency,
      summaryMaxChars: opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX,
      traceId: opts.traceId ?? `team-${Math.floor(Math.random() * 1e9).toString(36)}`,
      onEvent: opts.onEvent,
    };
  }

  /** Run the team and return all member results plus the winner. */
  async run(): Promise<AgentTeamResult> {
    const concurrency = this.#opts.maxConcurrency ?? this.#opts.members.length;
    const results: AgentTeamMemberResult[] = new Array(this.#opts.members.length);

    // Run in waves capped at `concurrency`.
    const queue = this.#opts.members.map((m, i) => ({ m, i }));
    while (queue.length) {
      const wave = queue.splice(0, concurrency);
      const settled = await Promise.all(
        wave.map(({ m, i }) =>
          this.#runMember(m, i).catch(
            (err): AgentTeamMemberResult => ({
              label: m.label,
              memberId: this.#memberId(i),
              finalAnswer: null,
              summary: "",
              events: [],
              workspaceChanges: [],
              score: null,
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

    if (this.#opts.scorer) await this.#scoreAll(results);

    // Rank: descending by score; failed members (score === null OR error) sink.
    const ranking = results
      .map((_r, i) => i)
      .sort((a, b) => {
        const ra = results[a];
        const rb = results[b];
        if (!ra || !rb) return 0;
        const sa = ra.error ? -1 : (ra.score ?? -0.5);
        const sb = rb.error ? -1 : (rb.score ?? -0.5);
        if (sb !== sa) return sb - sa;
        return a - b;
      });

    const winner = (() => {
      for (const i of ranking) {
        const r = results[i];
        if (r && !r.error && r.score !== null) return i;
      }
      // No scorer (or every member failed): fall back to the first successful member.
      for (const i of ranking) {
        const r = results[i];
        if (r && !r.error) return i;
      }
      return null;
    })();

    return {
      results,
      winner,
      ranking,
      parentSummary: this.#buildParentSummary(results, winner, ranking),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #memberId(i: number): string {
    return `${this.#opts.traceId}-m${i}`;
  }

  async #runMember(member: AgentTeamMember, index: number): Promise<AgentTeamMemberResult> {
    const memberId = this.#memberId(index);
    const fork = await this.#opts.baseWorkspace.fork(memberId);
    const tools = member.tools ?? this.#opts.tools ?? [];
    const ctx: AgentTeamSpawnContext = {
      task: member.taskOverride ?? this.#opts.task,
      model: member.model ?? this.#opts.model,
      tools,
      workspace: fork,
      memberId,
      parentTraceId: this.#opts.traceId,
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
      finalAnswer,
      summary: this.#summariseEvents(events, finalAnswer, errorMessage),
      events,
      workspaceChanges,
      score: null,
      error: errorMessage,
    };
  }

  async #scoreAll(results: AgentTeamMemberResult[]): Promise<void> {
    const scorer = this.#opts.scorer;
    if (!scorer) return;
    await Promise.all(
      results.map(async (r) => {
        if (r.error) return;
        try {
          const s = await scorer({
            label: r.label,
            memberId: r.memberId,
            finalAnswer: r.finalAnswer,
            events: r.events,
            workspaceChanges: r.workspaceChanges,
          });
          // Clamp scorer return into [0, 1] — defensive against custom
          // scorers that misbehave; never let one bad scorer break ranking.
          r.score = Math.max(0, Math.min(1, Number.isFinite(s) ? s : 0));
        } catch (err) {
          r.score = null;
          r.error = `scorer failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    );
  }

  /** Compress events down to a short, bounded string for parent injection. */
  #summariseEvents(events: AgentEvent[], finalAnswer: unknown, error: string | null): string {
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
            typeof ev.data.answer === "string" ? ev.data.answer : JSON.stringify(ev.data.answer);
          lines.push(`final: ${a?.slice(0, 200) ?? ""}`);
          break;
        }
        default:
          break;
      }
    }
    if (!lines.length && finalAnswer != null) {
      const a = typeof finalAnswer === "string" ? finalAnswer : JSON.stringify(finalAnswer);
      lines.push(`final: ${a.slice(0, 200)}`);
    }
    return lines.join("\n");
  }

  #buildParentSummary(
    results: AgentTeamMemberResult[],
    winner: number | null,
    ranking: number[]
  ): string {
    const max = this.#opts.summaryMaxChars;
    const parts: string[] = [];
    if (winner !== null) {
      const w = results[winner];
      if (w) {
        const ans =
          typeof w.finalAnswer === "string" ? w.finalAnswer : JSON.stringify(w.finalAnswer);
        parts.push(
          `winner: ${w.label}${w.score !== null ? ` (score=${w.score.toFixed(2)})` : ""}\n${ans?.slice(0, max - 200) ?? ""}`
        );
      }
    }
    const runnerUps = ranking.filter((i) => i !== winner).slice(0, 3);
    for (const i of runnerUps) {
      const r = results[i];
      if (!r) continue;
      const tag = r.error ? "ERR" : `${r.score?.toFixed(2) ?? "n/a"}`;
      const ans =
        typeof r.finalAnswer === "string" ? r.finalAnswer : JSON.stringify(r.finalAnswer ?? "");
      parts.push(`- ${r.label} [${tag}] ${ans?.slice(0, 120) ?? ""}`);
    }
    const joined = parts.join("\n\n");
    return joined.length > max ? `${joined.slice(0, max - 3)}...` : joined;
  }
}

/**
 * Convenience scorer: pick the longer non-empty answer (tie-break by lower
 * member index). Useful as a placeholder before plugging in a real judge —
 * NOT recommended for production.
 */
export function longestAnswerScorer(): AgentTeamScorer {
  return ({ finalAnswer }) => {
    const s = typeof finalAnswer === "string" ? finalAnswer : JSON.stringify(finalAnswer ?? "");
    if (!s) return 0;
    // Map length to (0, 1) via a soft saturation — 1000 chars ~ 0.5; longer
    // answers do better but never reach exactly 1 (no division-by-zero edge).
    return s.length / (s.length + 1000);
  };
}
