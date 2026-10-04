---
"@wasmagent/core": minor
"@wasmagent/mcp-gateway": minor
"@wasmagent/mcp-firewall": minor
---

feat(core): IF-07c agent-loop provenance wiring

- `ToolCallingAgent` accepts a per-run `policyGateway` port
  (`RunPolicyGateway`, structural — see `src/policies/policyGateway.ts`):
  `evaluateBeforeCall` judges each call before dispatch (after tool
  guardrails, before human approval), `observeResult` receives the exact
  string entering message history.
- Denied calls are blocked before execution and fed back to the model as a
  `policy_denied` error result (additive `ToolResult.error.code` member);
  the run survives and dependents are unaffected. `confirm` decisions route
  through the existing checkpointer approval flow and degrade fail-closed to
  deny without one. Unwired agents behave exactly as before.
- Pinned by `src/agents/ToolCallingAgent.provenance.test.ts` (fake port,
  DAG + parallel modes, byte-identity, lifecycle).

feat(mcp-gateway): `createAgentPolicyGateway` implements the port over
`MCPGateway` — the IF-07a provenance gate fires automatically inside a wired
run: run-scoped bounded ledger threaded on every evaluate, profile-declared
`resultTaintLabels` minted at result time (serialized form + JSON string
leaves), gateway `ask_user` mapped to the human-approval flow, unknown
descriptors denied fail-closed. End-to-end pinned by
`src/agent-loop.test.ts` (labeled read → automatic deny at the next sink;
identity rule fires under renames/encodings).

feat(mcp-firewall): trusted profiles gain additive `resultTaintLabels`
(operator-authoritative mint, no DLP); `GatewayDecision.resultTaintLabels`
surfaces them to the runtime. FI matrix ceilings upgraded honestly:
threading is caller-side or run-scoped by a wired agent runtime (IF-07c);
there is still no automatic process-wide taint ledger.
