# OWASP MCP Top 10 — WasmAgent Defense Demo

This directory demonstrates WasmAgent defenses against the
[OWASP MCP Top 10](https://genai.owasp.org/) attack categories.

Each scenario presents a simulated malicious MCP tool entry and shows how
WasmAgent's `@wasmagent/mcp-firewall` static-vetting layer detects and
handles the attack — without any ML or network calls.

## How to run

```bash
# From repo root (after building packages):
node examples/owasp-demo/run-demo.mjs

# Or run a specific scenario by id:
node examples/owasp-demo/run-demo.mjs owasp-mcp-01
```

## Scenarios

| ID | OWASP Risk | Expected Outcome | WasmAgent Primitive |
|---|---|---|---|
| owasp-mcp-01 | Tool Poisoning / Prompt Injection | **block** | `vetTool` (tool_poisoning) |
| owasp-mcp-02 | Excessive Privilege / Scope Creep | **ask_user** | `vetTool` (exfiltration) |
| owasp-mcp-03 | Rug Pull: Descriptor Drift | **block** | `vetTool` (tool_poisoning) |
| owasp-mcp-04 | SSRF / Confused Deputy | **ask_user** | `vetTool` (exfiltration) |
| owasp-mcp-05 | Taint Passthrough | **ask_user** | `vetTool` (invisible_chars → ask) |
| owasp-mcp-06 | Sampling Abuse | **ask_user** | `vetTool` (sampling_abuse) |
| owasp-mcp-07 | Supply Chain Tampering | **ask_user** | `vetTool` (exfiltration) |
| owasp-mcp-08 | Steganography via Invisible Unicode | **ask_user** | `vetTool` (invisible_chars → ask) |
| owasp-mcp-09 | Insufficient AuthN | **block** | `vetTool` (tool_poisoning) |
| owasp-mcp-10 | Intent Flow Subversion | **ask_user** | `vetTool` (invisible_chars → ask) |

## What each outcome means

- **block** — `vetTool` found a critical/deny-level pattern (e.g., prompt
  injection). The tool should not be invoked.
- **ask_user** — `vetTool` found a high or medium-risk pattern (e.g., credential
  access, sampling abuse, invisible Unicode characters). The agent must pause and
  get explicit user approval.
- **allow** — No attack patterns detected; the tool passed static vetting.

## How WasmAgent processes this in production

1. `snapshotTool(entry, serverId)` — hash the descriptor at first-seen time.
2. `vetTool(entry)` — deterministic pattern scan (this demo layer).
3. `evaluatePolicy(...)` — combine vetting result + consent ledger → invocation decision.
4. `taintObservation(...)` — wrap tool results in a typed trust boundary before
   they reach the next LLM call.
5. All decisions emitted as `AEPRecord` evidence fields (`tool_manifest_digest`,
   `capability_decisions`, `actions[].input_taint_labels`).

## No API key required

All scenarios run purely against the deterministic `vetTool` function.
No model, no network call, no credentials needed.

## Related examples

- `examples/dangerous-tool-demo/` — end-to-end gateway + taint demo
- `examples/owasp-demo/owasp-demo.mjs` — QuickJS kernel capability enforcement
  (runtime sandboxing, separate layer from static vetting)
