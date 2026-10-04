// ─────────────────────────────────────────────────────────────────────────────
// @wasmagent/core — PolicyGatewayPort (IF-07c)
// ─────────────────────────────────────────────────────────────────────────────
// Structural port between the agent loop and an external policy engine
// (e.g. the MCP firewall's provenance gate, composed via @wasmagent/mcp-gateway).
//
// Design boundary (honest claim ceiling): core knows nothing about taint
// labels or provenance. It only (a) asks the port to judge each tool call
// before dispatch and (b) feeds the port the exact string that is about to
// enter message history for each tool result. The port decides what to
// remember and what to deny. Core maintains no taint ledger; a port that
// keeps one owns its lifetime — the per-run factory form gives it a
// run-scoped home that dies with the run.

import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentPrincipal, ToolCall, ToolResult } from "../tools/types.js";

/** A tool call the port must judge before dispatch. */
export interface PolicyCallRequest {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Port verdict for one tool call. */
export type PolicyCallDecision =
  | { action: "allow" }
  | {
      action: "deny";
      /** Policy rule IDs that matched — the evidence channel for AEP records. */
      ruleIds: string[];
      reason: string;
    }
  | {
      action: "confirm";
      /** Human-facing prompt; routed through the agent's checkpointer approval flow. */
      prompt: string;
      reason: string;
    };

/** A settled tool result, observed just before it enters message history. */
export interface PolicyResultObservation {
  callId: string;
  toolName: string;
  /**
   * Byte-identical to the string that enters message history (after
   * sanitizeToolResult/toModelOutput/stringify and error-fallback
   * augmentation). Content hashes computed over this string match values the
   * model later passes as args in subsequent calls.
   */
  output: string;
  /**
   * True when the result is an execution/policy failure. Error text is
   * framework commentary, not tool output content — implementations must not
   * mint result labels from it.
   */
  isError: boolean;
}

/**
 * Per-run policy port. Implementations should be run-scoped (created via the
 * `policyGateway` factory per run) so internal state — e.g. a provenance
 * ledger — is discarded with the run instead of leaking across runs or
 * processes. There is deliberately no process-wide ledger here.
 */
export interface RunPolicyGateway {
  /**
   * Judge a proposed tool call before dispatch. Synchronous by design: the
   * firewall's evaluate() is synchronous, and the pre-dispatch path must not
   * reorder relative to the approval gate.
   */
  evaluateBeforeCall(req: PolicyCallRequest): PolicyCallDecision;
  /** Observe a settled tool result (see PolicyResultObservation.output). */
  observeResult(obs: PolicyResultObservation): void;
}

/** A run-scoped gateway instance, or a factory receiving the run's traceId. */
export type PolicyGatewayFactory =
  | RunPolicyGateway
  | ((run: { traceId: string }) => RunPolicyGateway);

/** Resolve the option form (instance or factory) to a concrete per-run port. */
export function resolvePolicyGateway(
  policyGateway: PolicyGatewayFactory | undefined,
  traceId: string
): RunPolicyGateway | undefined {
  if (!policyGateway) return undefined;
  return typeof policyGateway === "function" ? policyGateway({ traceId }) : policyGateway;
}

/**
 * Dispatch-time deny enforcement. A ToolRegistry subclass that answers denied
 * calls with a blocked ToolResult instead of executing them and delegates
 * everything else. Subclass (not a wrapper object) because Scheduler types
 * its registry as the ToolRegistry class. Resolving with an error result —
 * rather than rejecting — keeps the Scheduler's dependent-node semantics
 * intact: a blocked node completes with an error and its dependents still run.
 */
export class PolicyGatedRegistry extends ToolRegistry {
  readonly #inner: ToolRegistry;
  readonly #decisions: Map<string, PolicyCallDecision>;

  constructor(inner: ToolRegistry, decisions: Map<string, PolicyCallDecision>) {
    super();
    this.#inner = inner;
    this.#decisions = decisions;
  }

  override async call(
    toolCall: ToolCall,
    grantedCapabilities?: string[],
    principal?: AgentPrincipal
  ): Promise<ToolResult> {
    const decision = this.#decisions.get(toolCall.callId);
    if (decision?.action === "deny") {
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "policy_denied",
          message: `Blocked by policy [${decision.ruleIds.join(", ")}]: ${decision.reason}`,
          retryHint: "Do not retry the same call verbatim — remove or replace the flagged input.",
        },
      };
    }
    return this.#inner.call(toolCall, grantedCapabilities, principal);
  }
}
