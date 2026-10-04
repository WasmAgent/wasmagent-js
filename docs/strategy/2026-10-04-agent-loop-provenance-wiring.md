# 2026-10-04 — Agent-loop provenance wiring (IF-07c)

## What shifted

The provenance-preserving information-flow gate (IF-07a) was real but
unreachable from the real agent loop: `@wasmagent/core` had no dependency on
the firewall and no `gateway.evaluate` call anywhere in `ToolCallingAgent`.
As of this change, a wired `ToolCallingAgent` threads provenance
automatically — a secret read by a profile-labeled tool is blocked at the
next dangerous sink with no caller code.

- **Port**: `@wasmagent/core` `RunPolicyGateway` (structural, zero firewall
  dependency) + `ToolCallingAgentOptions.policyGateway` (per-run factory).
- **Adapter**: `@wasmagent/mcp-gateway` `createAgentPolicyGateway` —
  run-scoped bounded ledger, profile-declared `resultTaintLabels` minting,
  `ask_user` → human-approval mapping, fail-closed on unknown descriptors.
- **Scope posture**: threading is run-scoped and opt-in. There is still no
  process-wide taint ledger (the IF-07a ceiling holds verbatim); CodeAgent
  and model-side transforms remain out of scope.

## Evidence

- `packages/core/src/agents/ToolCallingAgent.provenance.test.ts` — port
  semantics against a fake policy engine (deny/confirm/observe byte-identity,
  both scheduler modes, unwired zero-change).
- `packages/mcp-gateway/src/agent-loop.test.ts` — real `ToolCallingAgent` +
  real `MCPGateway` end-to-end: labeled read → automatic deny at the next
  sink (label rule); base64 transform through a labeled tool → identity rule
  fires; benign unlabeled runs unaffected; ledger cap eviction.
- Protocol matrix `FI-TAINT-PROPAGATION` / `FI-RESULT-TO-NEXT-CALL` /
  `FI-CROSS-TOOL-FLOW` ceilings upgraded to "run-scoped threading by a wired
  agent runtime; flows outside a wired run remain caller responsibility";
  conformance report regenerated at the new baseline.

## Competitive note

Other JS agent frameworks either bolt content scanning onto prompts (DLP
posture, false-positive prone, no operator authority) or leave cross-tool
data-flow policy entirely to the application. The combination here —
operator-declared labels + byte-exact identity matching + deny decisions
that survive consent — is wired into the executor itself and CI-pinned,
not a middleware the integrator must remember to compose.
