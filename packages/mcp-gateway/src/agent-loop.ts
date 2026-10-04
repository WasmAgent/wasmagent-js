/**
 * Agent-loop composition (IF-07c).
 *
 * Implements @wasmagent/core's `RunPolicyGateway` port on top of MCPGateway
 * so the IF-07a provenance gate fires automatically inside a wired
 * ToolCallingAgent run — no caller-side provenance threading required:
 *
 *   1. evaluateBeforeCall — every proposed call is evaluated by the gateway
 *      with the run's accumulated provenance threaded as `inputProvenance`.
 *      deny → blocked call (core feeds the reason back to the model);
 *      ask_user → routed through the agent's human-approval flow.
 *   2. observeResult — results of tools whose trusted profile declares
 *      `resultTaintLabels` are minted into labeled observations and enter
 *      the run's ledger, so the next evaluate sees them.
 *
 * Design boundary (honest claim ceiling): the ledger is RUN-SCOPED — created
 * per `run()` via the factory form, discarded with the run, never shared
 * across runs or processes. There is no process-wide taint ledger. Only
 * profile-labeled tool outputs are tracked (operator-authoritative, no DLP):
 * content the model transforms itself without an intervening labeled tool
 * result is outside this gate. A tool without a registered descriptor is
 * denied fail-closed — the gateway cannot evaluate what it cannot see.
 */

import type {
  PolicyCallDecision,
  PolicyCallRequest,
  PolicyResultObservation,
  RunPolicyGateway,
} from "@wasmagent/core";
import {
  createRequestIdentity,
  type GatewayRequest,
  type MCPGateway,
  PROVENANCE_SENSITIVE_LABELS,
  type RequestIdentity,
  type TaintedObservation,
  taintObservation,
} from "@wasmagent/mcp-firewall";
import type { McpToolEntry } from "@wasmagent/mcp-server";

/** Options for `createAgentPolicyGateway` — the composition-level config. */
export interface AgentPolicyGatewayOptions {
  /** The enforcing gateway (typically hardened, with a profile registry). */
  gateway: MCPGateway;
  /**
   * Descriptor for every tool that can flow through the wired agent. Tool
   * calls without a descriptor here are denied fail-closed. When several
   * entries share a name the last one wins.
   */
  toolDescriptors: McpToolEntry[];
  /** Gateway serverId under which the descriptors are evaluated. */
  serverId: string;
  /**
   * Stable principal string hashed into the per-run RequestIdentity.
   * Default "agent-loop". Consent records are principal-scoped, so give
   * distinct agents distinct principals.
   */
  principal?: string;
  /**
   * Max observations retained in the run ledger. On overflow the first
   * non-sensitive observation is evicted; if every entry is sensitive, the
   * oldest is. Default 512.
   */
  ledgerCap?: number;
}

/** Default ledger bound. Generous for a run; bounded so a runaway loop cannot grow memory without limit. */
const DEFAULT_LEDGER_CAP = 512;

/** Max distinct string leaves minted per observed result. */
const MAX_LEAVES_PER_RESULT = 64;

/** Same walk caps as the gate's arg matcher (resource-path.ts deepStringValues). */
const LEAF_WALK_MAX_DEPTH = 8;
const LEAF_WALK_MAX_NODES = 512;

function hasSensitiveLabels(obs: TaintedObservation): boolean {
  return obs.taintLabels.some((l) =>
    (PROVENANCE_SENSITIVE_LABELS as readonly string[]).includes(l)
  );
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Collect the distinct string leaves of a parsed JSON value (bounded walk). */
function jsonStringLeaves(value: unknown): string[] {
  const out = new Set<string>();
  const queue: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  let visited = 0;
  while (queue.length > 0 && out.size < MAX_LEAVES_PER_RESULT && visited < LEAF_WALK_MAX_NODES) {
    const next = queue.shift();
    if (next === undefined) break;
    visited++;
    const { v, d } = next;
    if (typeof v === "string") {
      out.add(v);
      continue;
    }
    if (v === null || typeof v !== "object" || d >= LEAF_WALK_MAX_DEPTH) continue;
    if (Array.isArray(v)) {
      for (const item of v) queue.push({ v: item, d: d + 1 });
    } else {
      for (const item of Object.values(v as Record<string, unknown>)) {
        queue.push({ v: item, d: d + 1 });
      }
    }
  }
  return [...out];
}

/**
 * Per-run port instance. Created by the factory returned from
 * `createAgentPolicyGateway` once per `ToolCallingAgent.run()` — the ledger
 * and the per-run identity die with the run.
 */
class RunScopedAgentPolicyGateway implements RunPolicyGateway {
  readonly #gateway: MCPGateway;
  readonly #descriptors: Map<string, McpToolEntry>;
  readonly #serverId: string;
  readonly #identity: RequestIdentity;
  readonly #ledgerCap: number;
  readonly #ledger: TaintedObservation[] = [];
  /** callId → result labels stashed from the call's GatewayDecision (IF-07c). */
  readonly #resultLabels = new Map<string, TaintedObservation["taintLabels"]>();

  constructor(opts: AgentPolicyGatewayOptions, traceId: string) {
    this.#gateway = opts.gateway;
    this.#serverId = opts.serverId;
    this.#ledgerCap = opts.ledgerCap ?? DEFAULT_LEDGER_CAP;
    this.#descriptors = new Map(opts.toolDescriptors.map((d) => [d.name, d]));
    this.#identity = createRequestIdentity({
      principal: opts.principal ?? "agent-loop",
      sessionId: traceId,
    });
  }

  evaluateBeforeCall(req: PolicyCallRequest): PolicyCallDecision {
    const descriptor = this.#descriptors.get(req.toolName);
    if (!descriptor) {
      return {
        action: "deny",
        ruleIds: ["descriptor-unavailable"],
        reason: `No tool descriptor registered for "${req.toolName}" — the policy gateway cannot evaluate it (fail-closed).`,
      };
    }
    const request: GatewayRequest = {
      identity: this.#identity,
      serverId: this.#serverId,
      tool: descriptor,
      args: req.args,
      // Thread the run ledger whenever non-empty — the automatic equivalent
      // of the IF-07a caller-threading contract.
      ...(this.#ledger.length > 0 ? { inputProvenance: [...this.#ledger] } : {}),
    };
    const decision = this.#gateway.evaluate(request);
    // Stash the profile's result labels: this call's observation, minted at
    // observe time from the decision the gateway already resolved.
    this.#resultLabels.set(req.callId, decision.resultTaintLabels ?? []);
    const invocation = decision.invocation;
    if (invocation.decision === "deny") {
      return {
        action: "deny",
        ruleIds: invocation.matchedPolicyIds,
        reason: invocation.reasons.join("; ") || "denied by gateway policy",
      };
    }
    if (invocation.decision === "ask_user") {
      const reason = invocation.reasons.join("; ") || "gateway escalation";
      return {
        action: "confirm",
        prompt: `Policy gateway escalation for tool "${req.toolName}": ${reason} Approve execution?`,
        reason,
      };
    }
    return { action: "allow" };
  }

  observeResult(obs: PolicyResultObservation): void {
    const labels = this.#resultLabels.get(obs.callId);
    this.#resultLabels.delete(obs.callId);
    // No labels declared (no trusted profile) → nothing to track. Error text
    // is framework commentary, not tool output — never minted.
    if (!labels || labels.length === 0 || obs.isError) return;
    // Mint the exact string entering history…
    this.#admit(taintObservation(obs.toolName, obs.output, { taintLabels: labels }));
    // …plus every string the model could copy out of it: a JSON string
    // literal's decoded value and string leaves of parsed JSON structures
    // (bounded by the same caps as the gate's arg walk). Identity matching
    // is byte-exact, so minting only the serialized form would miss values
    // the model copies out of the result.
    const parsed = tryParseJson(obs.output);
    if (parsed === undefined) return;
    for (const leaf of jsonStringLeaves(parsed)) {
      if (leaf !== obs.output) {
        this.#admit(taintObservation(obs.toolName, leaf, { taintLabels: labels }));
      }
    }
  }

  #admit(obs: TaintedObservation): void {
    if (this.#ledger.length >= this.#ledgerCap) {
      const evictIdx = this.#ledger.findIndex((o) => !hasSensitiveLabels(o));
      this.#ledger.splice(evictIdx === -1 ? 0 : evictIdx, 1);
    }
    this.#ledger.push(obs);
  }
}

/**
 * Build the `policyGateway` option for `ToolCallingAgent`: a factory that
 * mints one run-scoped port instance per run. Pass the result directly to
 * `ToolCallingAgentOptions.policyGateway`.
 */
export function createAgentPolicyGateway(
  opts: AgentPolicyGatewayOptions
): (run: { traceId: string }) => RunPolicyGateway {
  return (run: { traceId: string }) => new RunScopedAgentPolicyGateway(opts, run.traceId);
}
