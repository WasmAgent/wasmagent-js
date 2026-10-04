# RFC: IF-07c agent-loop provenance wiring (core executor end-to-end)

## Problem

IF-07a shipped a provenance-preserving information-flow gate with an explicit
honest ceiling: provenance enters a decision **only when the caller threads
it**. In practice that meant the gate fired only for callers that manually
constructed `inputProvenance` — and reconnaissance for this RFC confirmed a
bigger structural fact: `@wasmagent/core` had **zero dependency** on
`@wasmagent/mcp-firewall`, the agent loop contained no `gateway.evaluate`
call at all, and the MCP tool path connected through the SDK client without
passing any policy layer. The gate was real but unreachable from the real
agent loop; "unthreaded flows remain caller responsibility" effectively
meant "no in-repo caller threads anything."

The IF-07a RFC's Why-not section rejected a process-wide content-hash taint
ledger and named the acceptable alternative: revisit "only with a concrete
lifecycle design." This RFC is that lifecycle design.

## Proposed shape

**Dependency inversion, not coupling.** `@wasmagent/core` defines a
structural port (`policies/policyGateway.ts`) and knows nothing about taint
labels:

- `RunPolicyGateway.evaluateBeforeCall(call) → allow | deny | confirm` —
  judged per call before dispatch, after guardrails and before human
  approval (a denied call never reaches the approver).
- `RunPolicyGateway.observeResult({ output, isError })` — receives the exact
  string about to enter message history (post-sanitize/post-stringify), so
  content hashes computed by the port match values the model later passes as
  arguments.

`ToolCallingAgentOptions.policyGateway` accepts a run-scoped factory. Deny
enforcement is a `ToolRegistry` subclass consulted by both scheduler modes —
a blocked call resolves with a `policy_denied` error result fed back to the
model (the run survives; dependents are unaffected). `confirm` decisions
route through the existing checkpointer approval flow; without a checkpointer
they degrade fail-closed to deny. Unwired agents behave exactly as before.

**The adapter owns the lifecycle.** `@wasmagent/mcp-gateway` (already the
composition package) implements the port over `MCPGateway`:

- per-run ledger of `TaintedObservation`s (bounded; evicts non-sensitive
  first), threaded wholesale as `inputProvenance` on every evaluate;
- results of tools whose trusted profile declares the new additive
  `resultTaintLabels` field are minted at observe time — the
  operator-authoritative mint, no DLP, no content scanning;
- observations cover the serialized result and the strings a model can copy
  out of it (JSON string literal decode + string leaves, walk-capped) so
  byte-exact identity matching survives the stringify boundary;
- gateway `ask_user` maps to the agent's human-approval flow; unknown tool
  descriptors deny fail-closed.

## Why-not (alternatives rejected)

- **Process-wide taint ledger** — unchanged rejection from IF-07a. The
  ledger is created per `run()` by the factory and dies with the run;
  nothing is shared across runs or processes, and the CR-07-pinned claim
  "no automatic process-wide taint ledger" stays literally true.
- **Core depends on mcp-firewall directly** — couples the executor to one
  policy engine and drags its dependency graph into every consumer; the port
  costs one small interface file and keeps the composition at the host.
- **Tool-boundary-only wrapping** — no natural host for the cross-call
  ledger, and native (non-MCP) tools stay outside the gate.
- **Args-matched threading** (thread only observations matching current
  args) — reduces the gate to the identity rule and abandons the label
  rule's declared-consumption semantics. Wholesale run-scoped threading is
  the conservative posture, with the operator-profile path as the documented
  legitimate-flow escape hatch.

## Claim ceiling

- **implemented**: port + adapter + automatic per-run threading + deny /
  confirm enforcement + profile-declared label minting.
- **not established**: cross-run or process-wide taint tracking (never);
  CodeAgent loop; default-on (opt-in via `policyGateway`); model-side
  transformations computed without an intervening labeled tool result
  (DLP-adjacent, stays not-implemented); independent security verification.
