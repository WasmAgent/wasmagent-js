# @wasmagent/capability-compiler

> **Maturity: alpha (v0.1.0)** — compile CapabilityManifest to policy, schema, and trace validator.

Turn a `CapabilityManifest` into three ready-to-use outputs: MCP tool schema fragments, deterministic runtime policy rules, and trace validator specs.

```bash
npm install @wasmagent/capability-compiler
```

---

## What it does

A `CapabilityManifest` declares what a sandboxed agent is allowed to do — which hosts it can reach, which paths it can read or write, and how much CPU it may use. `@wasmagent/capability-compiler` compiles that manifest into three targets:

| Target | Function | Output |
|---|---|---|
| MCP tool schema | `compileToMcpSchema` | JSON Schema fragment + documentation table + capability tags |
| Runtime policy | `compileToPolicy` | Deterministic allow/deny/warn evaluator — no ML |
| Trace validator | `compileToTraceValidator` | Checks a recorded ADP trace for manifest violations |

---

## Usage

```ts
import { compileToMcpSchema, compileToPolicy, compileToTraceValidator } from "@wasmagent/capability-compiler";

const manifest = {
  allowedHosts: ["api.example.com"],
  allowedReadPaths: ["/workspace"],
  allowedWritePaths: ["/workspace/output"],
  extraCapabilities: [],
  cpuMs: 3000,
};

// 1. MCP tool schema fragment
const { documentationTable, capabilityTags } = compileToMcpSchema(manifest, "edit_file");
// documentationTable: Markdown table of constraints
// capabilityTags: ["read:/workspace", "write:/workspace/output"]

// 2. Runtime policy
const policy = compileToPolicy(manifest);

const allowed = policy.evaluate({
  toolName: "write_file",
  args: { path: "/workspace/output/result.ts" },
  resolvedPath: "/workspace/output/result.ts",
});
// allowed.outcome === "allow"

const denied = policy.evaluate({
  toolName: "write_file",
  args: { path: "/etc/passwd" },
  resolvedPath: "/etc/passwd",
});
// denied.outcome === "deny"

// 3. Trace validator
const validator = compileToTraceValidator(manifest);
const violations = validator.validate(trace);
// violations[]: { step, rule, message } for each manifest breach
```

---

## CapabilityManifest fields

| Field | Type | Description |
|---|---|---|
| `allowedHosts` | `string[]` | Hostnames the agent may connect to |
| `allowedReadPaths` | `string[]` | File paths the agent may read |
| `allowedWritePaths` | `string[]` | File paths the agent may write |
| `extraCapabilities` | `string[]` | Additional named capabilities |
| `cpuMs` | `number` | CPU time budget in milliseconds |

---

## API

```ts
function compileToMcpSchema(manifest, toolName: string): McpCapabilitySchema
interface McpCapabilitySchema { documentationTable: string; capabilityTags: string[] }

function compileToPolicy(manifest): CompiledPolicy
interface CompiledPolicy { evaluate(call: ToolCall): PolicyCheckResult }
interface ToolCall { toolName: string; args: Record<string, unknown>; resolvedPath?: string }
interface PolicyCheckResult { outcome: PolicyOutcome; reason?: string }
type PolicyOutcome = "allow" | "deny" | "warn"

function compileToTraceValidator(manifest): TraceValidatorSpec
interface TraceValidatorSpec { validate(trace: TraceStep[]): TraceViolation[] }
interface TraceViolation { step: TraceStep; rule: string; message: string }
```

---

## Related packages

- [`@wasmagent/mcp-firewall`](../mcp-firewall/README.md) — runtime enforcement; use compiled policy rules
- [`@wasmagent/mcp-policy`](../mcp-policy/README.md) — bundle compiled rules into versioned `PolicyBundle`
- [`@wasmagent/aep`](../aep/README.md) — reference `capabilityTags` in AEP evidence records

---

## Recording Policy

`compileToRecordingPolicy` maps a `CapabilityManifest` + runtime `RiskContext` into a `RecordingPolicy` that tells the AEP emitter how much content to capture.

```ts
import { compileToRecordingPolicy } from "@wasmagent/capability-compiler";

const policy = compileToRecordingPolicy(manifest, {
  wasVetted: false,
  hasConsentAnomaly: false,
  taintChainLength: 0,
  sideEffectClass: "read",
});
// policy.mode === "validation"
// policy.reason === "read-only, no anomaly"
```

### Decision logic (priority order)

| # | Condition | Mode | Reason |
|---|---|---|---|
| 1 | `wasVetted === true` | full | tool flagged by vetting |
| 2 | `hasConsentAnomaly === true` | full | consent anomaly recorded |
| 3 | `taintChainLength > 0` AND `sideEffectClass !== "read"` | full | tainted input reaching state-changing call |
| 4 | `sideEffectClass === "unknown"` | full | unknown side-effect class |
| 5 | `sideEffectClass` is `"mutate-external"` or `"network-egress"` | full | external mutation |
| 6 | `sideEffectClass === "mutate-local"` | delta | local mutation, low risk |
| 7 | `sideEffectClass === "read"` | validation | read-only, no anomaly |

**Invariant:** `unknown` side-effect class always produces the highest severity (`full`).

## License

Apache-2.0
