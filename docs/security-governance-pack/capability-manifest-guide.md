# CapabilityManifest Configuration Guide

`CapabilityManifest` is the single object that defines the permission boundary
for every kernel invocation. It is the *only* way to grant a sandboxed agent
access to network, filesystem, environment variables, named tools, or compute
resources. Every absent or empty field means deny.

---

## Interface reference

From [`packages/core/src/executor/types.ts`](../../packages/core/src/executor/types.ts):

```ts
interface CapabilityManifest {
  /**
   * Allow outbound HTTP to these domains (glob patterns).
   * Empty array = no network at all.
   * Examples: ["api.github.com"], ["*.example.com"], ["*"] (wildcard — avoid in prod)
   */
  allowedHosts: string[];

  /**
   * Allow read access to these path prefixes.
   * Empty array = no filesystem reads.
   * The kernel's __fs__ bridge enforces this before any file open.
   * Examples: ["/workspace/my-session"], ["/workspace", "/tmp"]
   */
  allowedReadPaths: string[];

  /**
   * Allow write access to these path prefixes.
   * Empty array = no filesystem writes.
   * Write paths are checked independently of read paths.
   * Examples: ["/workspace/my-session/output"], []
   */
  allowedWritePaths: string[];

  /**
   * Extra named capabilities (e.g. "tool:web_search", "tool:run_tests").
   * A tool not in this list cannot be invoked from sandboxed code.
   * Empty array = no named tool access.
   */
  extraCapabilities: string[];

  /**
   * Environment variables to expose inside the sandbox as __env__ global.
   * This is an EXPLICIT value allow-list, NOT a pass-through of process.env.
   * The kernel never sees the host environment.
   * Absent / empty = no env access. The injected map is read-only (frozen).
   * Use sparingly — each entry crosses the trust boundary.
   */
  env?: Readonly<Record<string, string>>;

  /**
   * Hard ceiling for a single kernel.run() call, in milliseconds.
   * The lower of this and KernelOptions.timeoutMs wins (defence-in-depth).
   * Absent = no per-manifest limit (KernelOptions.timeoutMs still applies).
   * Recommendation: always set this in production.
   */
  cpuMs?: number;

  /**
   * Soft ceiling on memory usage, in bytes.
   * Enforced on QuickJS, Wasmtime, and RemoteSandboxKernel.
   * Advisory only on JsKernel and Pyodide — a warning is logged.
   * Default if absent: kernel-specific (QuickJS: 64 MB).
   */
  memoryLimitBytes?: number;
}
```

### Kernel honouring matrix

| Field | JsKernel | QuickJSKernel | PyodideKernel | WasmtimeKernel | RemoteSandboxKernel |
|---|---|---|---|---|---|
| `allowedHosts` | enforced | enforced | enforced | enforced | enforced |
| `allowedReadPaths` | enforced | enforced (via `__fs__` bridge) | enforced (via `__fs__` bridge) | enforced (via `__fs__` bridge) | enforced |
| `allowedWritePaths` | enforced | enforced (via `__fs__` bridge) | enforced (via `__fs__` bridge) | enforced (via `__fs__` bridge) | enforced |
| `extraCapabilities` | enforced | enforced | enforced | enforced | enforced |
| `env` | enforced | enforced | enforced | enforced | enforced |
| `cpuMs` | timeout | deadline | advisory | per-call | per-call |
| `memoryLimitBytes` | advisory | enforced | advisory | advisory | enforced (E2B) |

Advisory means the field is accepted and logged but the runtime cannot enforce
a hard limit. On kernels where it is advisory, calling code should treat
enforcement as best-effort only.

---

## Annotated example: restrictive production config

```ts
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { applyApprovalPolicy, PolicyPresets } from "@wasmagent/core";

const sessionId = req.headers.get("X-Session-Id") ?? crypto.randomUUID();

const kernel = new QuickJSKernel({
  capabilities: {
    // Network: only the project's own API and npm registry for package fetching.
    // No wildcard. An agent cannot DNS-resolve arbitrary hosts.
    allowedHosts: ["api.myapp.example.com", "registry.npmjs.org"],

    // Filesystem: read from the session workspace and a shared read-only
    // reference directory. No access to /etc, /home, or parent directories.
    allowedReadPaths: [
      `/workspace/${sessionId}`,
      "/workspace/shared/reference",
    ],

    // Filesystem: writes confined to the session output directory only.
    allowedWritePaths: [`/workspace/${sessionId}/output`],

    // Named tools: only the tools this session needs. Not "write_file" or
    // "delete_file" — those go through the ApprovalPolicy gate below.
    extraCapabilities: ["tool:read_file", "tool:run_tests"],

    // Env: only the values the agent needs for this session.
    // NOT process.env.ANTHROPIC_API_KEY — that stays on the host.
    env: {
      SESSION_ID: sessionId,
      BUILD_TARGET: "production",
    },

    // CPU: 10 s per kernel.run() call.
    // Combined with KernelOptions.timeoutMs: 8000 — the lower (8 s) wins.
    cpuMs: 10_000,

    // Memory: 128 MB QuickJS heap ceiling.
    memoryLimitBytes: 128 * 1024 * 1024,
  },
  timeoutMs: 8_000,
});

// Wrap write-class tools with the approval policy.
// In production: every write, delete, and rename requires operator approval.
const tools = applyApprovalPolicy(PolicyPresets.strict(), baseTools);
```

---

## Policy presets

Three built-in presets cover common deployments. All are defined in
`packages/core/src/policies/approvalPolicy.ts`.

### `PolicyPresets.permissive()`

All writes run without approval. Use in local dev sandboxes and CI pipelines
where a human is watching the terminal output.

```ts
import { PolicyPresets } from "@wasmagent/core";
const tools = applyApprovalPolicy(PolicyPresets.permissive(), baseTools);
```

### `PolicyPresets.strict()`

Every write, patch, delete, and rename requires explicit approval. The agent
emits an `await_human_input` event and suspends until the operator confirms.
Use in production and in any session where the agent has access to non-throwaway
files.

```ts
const tools = applyApprovalPolicy(PolicyPresets.strict(), baseTools);
```

### `PolicyPresets.balanced()`

Sensible middle ground for team dev environments:

- Dotfiles and CI configs (`.env`, `.env.production`, `.github/`, `wrangler.toml`)
  always require approval.
- Deletes and renames always require approval.
- Large writes (> 5 000 characters) require approval.
- Small source-file edits run free.

```ts
const tools = applyApprovalPolicy(PolicyPresets.balanced(), baseTools);
```

### Custom rules

Rules are evaluated in registration order. The first matching rule wins.

```ts
import { ApprovalPolicy, applyApprovalPolicy } from "@wasmagent/core";

const policy = new ApprovalPolicy({
  defaultVerdict: "require", // require approval unless a rule allows it
  rules: [
    {
      id: "allow-small-test-writes",
      match: {
        op: ["write"],
        paths: ["/workspace/test/"],
        minSizeChars: 0,   // any size
      },
      verdict: "allow",   // short-circuit — no approval needed for test files
    },
    {
      id: "always-approve-deletions",
      match: { op: ["delete", "rename"] },
      verdict: "require",
    },
  ],
});
```

---

## How `needsApproval` triggers the HITL gate

When `needsApproval(input)` returns `true`, the tool wrapper does not execute.
Instead, the agent emits an `await_human_input` event with a `promptId` and
suspends its generator. The host must:

1. Observe the `await_human_input` event from the SSE stream.
2. Present the proposed action to the operator (path, op type, content size).
3. POST the operator's decision to the approval endpoint with `promptId`.
4. The agent resumes with the decision: `"approved"` → tool executes; anything
   else → tool is skipped and the agent receives a refusal string.

```
SSE:  { event: "await_human_input", data: { promptId: "p_abc", prompt: "Write 1.2 KB to /workspace/.env?", step: 3 } }

POST /approvals/:promptId  { "decision": "approved" }   →  tool executes
POST /approvals/:promptId  { "decision": "rejected" }   →  agent receives "Operator rejected this action."
```

The `EventLog` records both the `await_human_input` event and the subsequent
`tool_call` or `tool_result` event, giving a full audit trail of which writes
were approved by whom and when.

---

## Extending for custom tools

To register a custom tool that requires a named capability:

```ts
import type { ToolDefinition } from "@wasmagent/core";

const mySearchTool: ToolDefinition<{ query: string }, string> = {
  name: "web_search",
  description: "Search the web for information.",
  parameters: { /* JSON Schema */ },
  // The agent can only call this tool if "tool:web_search" is in extraCapabilities.
  requiredCapability: "tool:web_search",
  execute: async ({ query }) => { /* … */ },
};

// Manifest that grants this tool:
const capabilities = {
  allowedHosts: ["search.example.com"],
  allowedReadPaths: [],
  allowedWritePaths: [],
  extraCapabilities: ["tool:web_search"],
};
```

Tools without `requiredCapability` are always callable (appropriate for
read-only, side-effect-free tools). Tools with `requiredCapability` require the
string to appear in `extraCapabilities` — this is the recommended pattern for
any tool with external side effects.

---

*See also: [`docs/security/capability-manifest-owasp.md`](../security/capability-manifest-owasp.md)
for the full OWASP Agentic Top 10 coverage matrix and regulatory mapping.*
