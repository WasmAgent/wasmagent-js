# OWASP Agentic AI Top 10 → WasmAgent Controls

> **Standard:** OWASP Agentic AI Top 10 (2025-12 draft).
>
> **Posture:** WasmAgent directly enforces 7 of 10 risks at the runtime/kernel
> boundary. The remaining 3 are acknowledged boundary cases — the primitive
> supports mitigation but the enforcement decision belongs to the caller's
> governance layer. See [`docs/security/capability-manifest-owasp.md`](../security/capability-manifest-owasp.md)
> for the full coverage matrix with regulatory mapping.

---

## Coverage table

| OWASP ID | Risk | WasmAgent Control | Coverage |
|---|---|---|---|
| AA1 | Prompt Injection | `classifierGuardrail` (S1), `intentAlignmentGuardrail` (S2), `codeGuardrail` (S3), `systemPrompt` pinning, `isUntrusted` tag on external-origin tool outputs | Defence-in-depth; not a sole gate |
| AA2 | Insufficient Authorization | `CapabilityManifest` deny-all defaults; `extraCapabilities` named tool allow-list; `ApprovalPolicy` / `needsApproval` HITL gate | Directly enforced at kernel boundary |
| AA3 | Memory / State Poisoning | `SessionKvStore` isolation (prefix-namespaced per `X-Session-Id`); `kernel.reset()` clears cross-step WASM variables; `MemoryBlockSet` size caps | Kernel state: fully isolated. Durable memory persistence: caller's responsibility |
| AA4 | Data Exfiltration | `CapabilityManifest.allowedHosts` (outbound network allow-list); `CapabilityManifest.allowedReadPaths` (filesystem allow-list); `redactPostHook` strips secrets from tool outputs | Directly enforced; exfil via allowed hosts is a policy design concern |
| AA5 | Unsafe Code Execution | WASM kernel sandbox (QuickJS / Pyodide / Wasmtime); `cpuMs` hard deadline; `memoryLimitBytes` ceiling | Fully isolated on WASM kernels; `JsKernel` (`vm`) is advisory — use WASM kernels in production |
| AA6 | Excessive Permissions | `PolicyPresets` (permissive / balanced / strict); minimal-permission manifest pattern; deny-all defaults | Directly enforced; over-granting at construction time is a policy design concern |
| AA7 | Sensitive Data Leakage | `redactPostHook` (regex-based output rewrite); `EventLog` does not redact by default — caller wires hooks; `CapabilityManifest.env` is explicit, not a `process.env` pass-through | Built-in primitive available; wiring it is the caller's responsibility |
| AA8 | Supply Chain | No remote tool loading by default; `extraCapabilities` is a static string list; tools are registered at construction time, not dynamically fetched | Fully enforced by design |
| AA9 | Audit Trail Gaps | `EventLog` (KV-persisted, SSE-resumable, monotonic event IDs); OTel bridge (`model_start` / `model_done` / `guardrail_tripwire` events map to GenAI semconv spans); `RolloutForkRunner` checkpoint | Directly provided; SIEM integration is the caller's responsibility |
| AA10 | Training Data Poisoning | G3 contamination guard (`n_gram_hash` deduplication against eval set); build-result nonce (prevents forged `objective_score`); `RolloutRanker` provenance field; `validate-rlaif.mjs` CI gate | Directly enforced in the RLAIF pipeline; callers not using RLAIF are unaffected |

---

## Control details

### AA1 — Prompt Injection

**Risk:** Adversarial content in tool outputs or retrieved documents hijacks
the agent's objective.

**Controls:**

- **`classifierGuardrail` (S1)** — runs a separate model call (isolated from
  the agent's context) to classify task input and output for injection
  patterns. The classifier only sees the content to classify — it cannot be
  influenced by the agent's (potentially poisoned) tool history.

  ```ts
  import { classifierGuardrail } from "@wasmagent/core";

  const guard = classifierGuardrail({
    model: myAnthropicModel,
    onError: "closed",   // fail closed on classifier errors in production
  });
  // Wire as input + output guardrail on ToolCallingAgent
  ```

- **`intentAlignmentGuardrail` (S2)** — before each tool call, checks whether
  the proposed action aligns with the original task. Uses an isolated model
  call that sees only the original task and the proposed action — not the
  possibly-contaminated tool history.

- **`codeGuardrail` (S3)** — static pattern scan of generated code before
  it enters the kernel. Blocks `child_process`, `exec`, `eval`, `fs.write`,
  `process.exit`, and custom patterns.

- **`isUntrusted` tag** — set `isUntrusted: true` on `ToolUseStep` entries
  whose output came from untrusted external sources. This marks the content
  in conversation history so downstream guardrails can apply stricter scrutiny.

- **`systemPrompt` pinning** — place security-critical instructions in the
  system prompt rather than the user turn. The system prompt is not
  concatenated with user or tool content in the message assembler.

---

### AA2 — Insufficient Authorization

**Risk:** Agent performs actions beyond its intended scope — writing to
unauthorized paths, calling tools it should not have access to, or bypassing
operator approval.

**Controls:**

- `CapabilityManifest.extraCapabilities` — static allow-list of named tools.
  A tool not in this list cannot be invoked from sandboxed code.
- `CapabilityManifest.allowedReadPaths` / `allowedWritePaths` — filesystem
  prefixes the agent may access.
- `ApprovalPolicy.needsApproval` — write-class tool wrappers consult the
  policy before executing. If approval is required, the agent suspends and
  emits `await_human_input`.

See [capability-manifest-guide.md](capability-manifest-guide.md) for full
configuration details and preset examples.

---

### AA3 — Memory / State Poisoning

**Risk:** Adversarial inputs persist into long-term memory and corrupt future
sessions.

**Controls:**

- **`SessionKvStore`** — all KV keys are namespaced under
  `session:<id>:...`. A session cannot read or write another session's keys
  without knowing its session ID.
- **`kernel.reset()`** — clears all cross-step variables in the WASM linear
  memory. Call between sessions (or between runs) to guarantee no implicit
  state leakage.
- **`MemoryBlockSet` size caps** — the memory package supports maximum block
  count and byte limits to bound unbounded memory accumulation.

---

### AA4 — Data Exfiltration

**Risk:** Agent reads secrets or sensitive files and exfiltrates them via
outbound network calls.

**Controls:**

- **`allowedHosts: []`** (deny-all default) — no outbound HTTP, no DNS
  resolution, no WebSocket. WASM kernels have no socket primitive at all.
- **`allowedReadPaths: []`** (deny-all default) — no filesystem reads.
- **`redactPostHook`** — strips regex-matched patterns (e.g. API key formats)
  from tool outputs before they enter the agent's context window.

  ```ts
  import { redactPostHook } from "@wasmagent/core";

  const redact = redactPostHook({
    pattern: /sk-[A-Za-z0-9]{32,}/g,
    replacement: "[REDACTED]",
  });
  ```

---

### AA5 — Unsafe Code Execution

**Risk:** Agent generates and executes malicious code that escapes the sandbox.

**Controls:**

- **WASM kernel boundary** — QuickJS and Pyodide run inside WebAssembly linear
  memory; Wasmtime adds hardware-level WASM isolation. The WASM VM has no
  direct syscall path, no native FFI, and no access to host globals.
- **`cpuMs`** — hard per-invocation deadline. The kernel throws
  `ExecutionTimeoutError` when exceeded, terminating runaway code.
- **`memoryLimitBytes`** — caps the QuickJS heap.

> Note: `JsKernel` (Node.js `vm`) does not provide WASM-level isolation.
> Use `QuickJSKernel` or `WasmtimeKernel` in production.

---

### AA6 — Excessive Permissions

**Risk:** Manifest grants broader access than the task requires, expanding the
blast radius of any compromise.

**Controls:**

- **Deny-all defaults** — every field in `CapabilityManifest` defaults to
  deny. Access is granted only by explicit positive entries.
- **`PolicyPresets`** — three built-in presets from permissive to strict.
  `PolicyPresets.strict()` requires approval for every write.
- **Minimal-permission pattern** — scope `allowedReadPaths` and
  `allowedWritePaths` to `/workspace/<sessionId>` only; scope `allowedHosts`
  to the specific APIs the task needs; scope `extraCapabilities` to the exact
  tools required.

---

### AA7 — Sensitive Data Leakage

**Risk:** Agent leaks PII, secrets, or confidential content in its responses
or in log output.

**Controls:**

- **`redactPostHook`** — rewrites tool outputs matching a regex pattern before
  they reach the agent's context. Chains are supported (multiple hooks applied
  in order).
- **`CapabilityManifest.env`** — explicit value allow-list, not a
  `process.env` pass-through. The host's secrets never enter the sandbox unless
  explicitly granted.
- **`EventLog` caller-wired redaction** — the `EventLog` does not redact
  events automatically; callers wire `redactPostHook` to filter sensitive
  fields before they are persisted to KV or exported via OTel.

---

### AA8 — Supply Chain

**Risk:** Agent dynamically loads tools or code from untrusted remote sources.

**Controls:**

- **No remote tool loading by default** — tools are registered at kernel
  construction time as `ToolDefinition` objects. There is no dynamic tool
  discovery endpoint, no remote plugin marketplace, and no `npm install` inside
  the sandbox.
- **`extraCapabilities` static allow-list** — tools must be named at
  construction time. A tool that is not in the registry cannot be invoked,
  regardless of what code attempts to call it.

---

### AA9 — Audit Trail Gaps

**Risk:** Insufficient logging makes it impossible to reconstruct what the
agent did, when, and why.

**Controls:**

- **`EventLog`** — every `AgentEvent` is persisted to KV under
  `evlog:<traceId>:<paddedSeq>`. Events are monotonically numbered and
  lexicographically sorted. See [audit-events.md](audit-events.md) for the
  full event catalogue and query examples.
- **OTel bridge** — `model_start` / `model_done` events carry `modelId`,
  step index, token counts, and `estimatedUsd`; `guardrail_tripwire` events
  carry `guardrailName` and `layer`. These map directly to OpenTelemetry
  GenAI semantic conventions for span ingestion.
- **`RolloutForkRunner` checkpoint** — multi-branch runs checkpoint after each
  branch, recording branch index, temperature, tool call sequence, and
  `objective_score`.

---

### AA10 — Training Data Poisoning

**Risk:** An attacker injects low-quality or adversarial examples into the
RLAIF training pipeline, corrupting model fine-tuning.

**Controls:**

- **Build-result nonce** — the `/build-result` callback requires a one-time
  nonce issued at job dispatch. Forged `objective_score` values without a
  valid nonce are rejected with HTTP 403.
- **G3 contamination guard** — every rollout record carries an `n_gram_hash`
  (16-hex SHA-256 prefix of the task string). The `validate-rlaif.mjs` CI
  script checks that training records do not overlap with the eval fixture
  set.
- **`RolloutRanker` provenance** — every `DpoRecord` and `PpoRecord` carries
  a `provenance.source: "wasmagent-rollout"` field and a `session_id`. Records
  without valid provenance are rejected by `evomerge/datafactory/exporter.py`.
- **Schema CI enforcement** — `scripts/check-rollout-schema.mjs` (wasmagent-js)
  and `scripts/check-schema-fields.py` (trace-pipeline) verify wire format
  consistency on every commit.

---

*Last reviewed: 2026-06-23. Based on OWASP Agentic AI Top 10, 2025-12 draft.*
*Cross-reference: [`docs/security/capability-manifest-owasp.md`](../security/capability-manifest-owasp.md)
for regulatory mapping (EU AI Act Art. 14/15, ISO/IEC 42001, Colorado AI Act).*
