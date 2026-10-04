# MCP Guard — Policy Enforcement & Evidence

WasmAgent wraps any MCP server with deterministic policy enforcement and exports a
verifiable [AEP evidence bundle](../api/stability-policy.md) for every agent run.

## 5-minute quickstart

### 1. Install

```bash
npm install @wasmagent/mcp-gateway @wasmagent/aep
```

### 2. Scan your MCP server for risks

```bash
wasmagent scan-mcp ./tools.json
```

### 3. Generate a policy file

```bash
wasmagent init --guard
# → creates wasmagent.policy.yaml
```

### 4. Enforce policy

```bash
# Pipe your MCP tools/list response:
wasmagent guard --config wasmagent.policy.yaml < tools.json

# Or point at a file:
wasmagent guard --config wasmagent.policy.yaml --upstream tools.json
```

### 5. Export evidence

```bash
wasmagent evidence export --input evidence.jsonl --format html --out evidence.html
```

## What the guard checks

| Check | What it detects |
|---|---|
| Prompt injection | "ignore previous instructions", "you are now" etc. |
| Exfiltration | References to `api_key`, `process.env`, `/etc/passwd` |
| Sampling abuse | Tool description requests the host to call the LLM |
| Invisible characters | Zero-width spaces and other non-printable chars |
| Rug-pull detection | Tool descriptor changed since last snapshot |

## Policy YAML reference

```yaml
version: 1
mode: enforce   # enforce | audit | dry_run

defaults:
  tool_output_trust: untrusted
  require_evidence_for_state_change: true
  redact_secrets: true

allow:
  - filesystem.read
  - git.diff

require_approval:
  - filesystem.write
  - shell.exec

deny:
  - shell.rm_rf

budgets:
  max_tool_calls: 30

redaction:
  patterns:
    - api_key
    - token
```

## Programmatic usage

```ts
import { MCPGateway, buildServerCard, createRequestIdentity } from "@wasmagent/mcp-gateway";
import { AEPEmitter } from "@wasmagent/aep";

const identity = createRequestIdentity({ principal: "my-agent", sessionId: "run-001" });
const card = buildServerCard({ serverId: "my-server", tools: myTools, operatorVerified: false });
const gw = new MCPGateway({ serverCards: [card] });
const emitter = new AEPEmitter({ run_id: "run-001", model_id: "claude-haiku-4-5-20251001" });

for (const tool of myTools) {
  const decision = gw.evaluate({ identity, serverId: "my-server", tool, args: {} });

  if (decision.invocation.decision === "deny") {
    console.log(`Blocked: ${tool.name} — ${decision.invocation.reasons.join(", ")}`);
    continue;
  }

  // call the tool...
  const result = await callTool(tool, {});
  const obs = gw.wrapResult(tool.name, result, decision);

  emitter.addAction({ tool_name: tool.name, state_changing: decision.stateChanging, timestamp_ms: Date.now() });
  emitter.addCapabilityDecision({ capability: `tool:${tool.name}`, subject: "agent", resource: tool.name, decision: decision.invocation.decision });
}

const record = emitter.build();
// record.schema_version === "aep/v0.1"
```

## Information-flow provenance gate (IF-07a)

Tool results can be labeled and threaded into the **next** sink decision, so
a secret survives transformations (base64, rename, restructure) and is denied
by provenance — not by value shape:

```ts
import { propagateTaint } from "@wasmagent/mcp-firewall";

// 1. observe the result, minting labels at the source
const obs = gw.wrapResult("vault_read", result, read, { taintLabels: ["secret"] });

// 2. transform freely — labels follow via propagateTaint (it re-hashes the
//    derived content, anchoring its provenance identity)
const derived = propagateTaint(obs, "encode_step", Buffer.from(result).toString("base64"));

// 3. thread the provenance into the next call
const send = gw.evaluate({
  identity,
  serverId: "srv",
  tool: sender,
  args: { destination: url, payload_b64: derivedContent }, // any name, any depth
  inputProvenance: [derived],
});
// send.invocation.decision === "deny"
// send.invocation.matchedPolicyIds contains "sink-tainted-provenance-deny"
//   and/or "sink-tainted-identity-deny"
// send.evidenceRef.inputTaintLabels → ["secret"] (AEP input_taint_labels)
```

Deny matrix (explicit): labels `secret` / `credential` × sinks
`network_send` / `credential_use` / `shell_exec` / `filesystem_write`.
Honest boundary: provenance that is never threaded stays outside the gate —
there is no automatic process-wide taint ledger. Operator profiles
(`sensitiveArgPaths`) remain the independent structural fallback. Pinned by
`GATE-01..11` (`src/provenance-gate.test.ts`) and fixtures `IF-07a` /
`IF-07a-2` (`src/information-flow.test.ts`).

### Automatic threading in the agent runtime (IF-07c)

Hosts do not have to hand-thread provenance. `@wasmagent/core`'s
`ToolCallingAgent` accepts a per-run `policyGateway` port;
`@wasmagent/mcp-gateway` ships the reference adapter over `MCPGateway`:

```ts
import { ToolCallingAgent } from "@wasmagent/core";
import { MCPGateway } from "@wasmagent/mcp-firewall";
import { createAgentPolicyGateway } from "@wasmagent/mcp-gateway";

const agent = new ToolCallingAgent({
  tools,
  model,
  policyGateway: createAgentPolicyGateway({
    gateway: new MCPGateway({ profileRegistry }),
    toolDescriptors, // McpToolEntry for every registry tool
    serverId: "srv",
  }),
});
```

With the port wired, every call is evaluated before dispatch with the run's
provenance threaded automatically, and results of tools whose trusted profile
declares `resultTaintLabels: ["secret"]` are minted into the run ledger at
observe time — the vault→send flow above is denied with no caller code.

Honest boundaries (same posture, sharper scope): the ledger is **run-scoped**
— created per `run()` by the factory, discarded with the run; there is still
no automatic process-wide taint ledger. Wiring is opt-in (unwired agents
behave exactly as before). Whole-run threading means the per-call declaration
is run-wide: after a labeled read, later deny-sink calls are gated by the
label rule even with benign args — legitimate flows go through the
operator-profile path. Identity matching is byte-exact over the strings the
runtime observed (serialized result + JSON string leaves). Pinned by
`packages/core/src/agents/ToolCallingAgent.provenance.test.ts` (fake port)
and `packages/mcp-gateway/src/agent-loop.test.ts` (real gateway end-to-end).

## Run the demo

```bash
node examples/dangerous-tool-demo/index.mjs
```

See [`examples/dangerous-tool-demo/`](../../examples/dangerous-tool-demo/) for the full source.

## Threat model

WasmAgent MCP Guard is a **defence-in-depth layer**, not a security boundary. It:

- Blocks tools with known injection patterns deterministically
- Makes policy decisions auditable (reason codes, AEP evidence)
- Detects rug-pull (tool descriptor changes after snapshot)
- Does NOT replace network isolation or OS-level sandboxing
- Does NOT prevent a sufficiently sophisticated adversarial model from bypassing prompt-level checks
- Does NOT provide cryptographic guarantees without the optional `@wasmagent/mcp-attestation` layer

For high-stakes deployments, combine with WASM sandboxing (`@wasmagent/kernel-quickjs`) and
capability manifests (`@wasmagent/core` `CapabilityManifest`).

## Claude Desktop Integration

Add WasmAgent Guard as a transparent wrapper in your Claude Desktop MCP config
(`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-server-guarded": {
      "command": "npx",
      "args": [
        "@wasmagent/mcp-gateway",
        "proxy",
        "--config", "wasmagent.policy.yaml",
        "--upstream-command", "node",
        "--upstream-args", "/path/to/your/mcp-server.mjs"
      ],
      "env": {
        "WASMAGENT_RUN_ID": "claude-desktop-session"
      }
    }
  }
}
```

The guard process intercepts every `tools/call` request, applies your policy,
emits an AEP evidence record per action, and forwards allowed calls to the
upstream server unchanged. Denied calls return a structured MCP error so Claude
sees a clear refusal reason rather than a timeout.
