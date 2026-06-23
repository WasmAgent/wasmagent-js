# WasmAgent Threat Model

> **Audience:** security architects and enterprise risk teams evaluating WasmAgent.
>
> **Structure:** for each threat category we state the attack scenario,
> which mechanism blocks it, what the default behaviour is, and how to harden
> beyond the default. The last column is honest: we name what is NOT covered.

---

## 1. Code execution escape

**Scenario:** The LLM generates malicious JavaScript or Python (e.g. reading
`/etc/passwd`, spawning a child process, exfiltrating environment variables).

| Aspect | Detail |
|---|---|
| **Mechanism** | WASM kernel sandbox. Generated code runs inside QuickJS (JS) or Pyodide (Python), both compiled to WebAssembly. The WASM linear memory is isolated from the host process. There is no `child_process`, no native FFI, no direct syscall surface inside the WASM VM. |
| **Default behaviour** | Deny-all. An empty `CapabilityManifest` means the sandboxed code has no network, no filesystem, no env access. |
| **How to harden** | Use `QuickJSKernel` or `WasmtimeKernel` rather than `JsKernel` (Node.js `vm`) for production. The `vm` module is lightweight but shares the host V8 heap; true WASM isolation requires a WASM-based kernel. Set `cpuMs` and `memoryLimitBytes` to bound runaway loops. |
| **What is NOT covered** | `JsKernel` (Node.js `vm`) does not provide WASM-level isolation — the host process memory is theoretically reachable via prototype-chain attacks on unpatched Node versions. Use it only in controlled dev environments. |

---

## 2. Tool abuse

**Scenario:** The model calls write-class tools (`write_file`, `delete_file`,
`patch_file`) without explicit authorisation, either through error, prompt
drift, or injection.

| Aspect | Detail |
|---|---|
| **Mechanism** | `CapabilityManifest.extraCapabilities` — only tools listed can be invoked from within sandboxed code. `ApprovalPolicy` / `needsApproval` — write-class tool wrappers consult a rule-based policy before executing; if `needsApproval` returns `true`, the agent emits an `await_human_input` event and suspends until the operator confirms. |
| **Default behaviour** | `ApprovalPolicy.permissive()` — no rules, all writes run free (suitable for dev). |
| **How to harden** | Switch to `PolicyPresets.strict()` (every write requires approval) or `PolicyPresets.balanced()` (dotfiles, env files, deletes, and large writes require approval; small source-file edits run free). Wire the `await_human_input` event to your approval UI. Example: |
| | `applyApprovalPolicy(PolicyPresets.strict(), tools)` |
| **What is NOT covered** | Tool selection within the LLM's reasoning trace — the policy intercepts at execution time, not at intent time. A governance layer (e.g. `intentAlignmentGuardrail`) should check intent before the tool call reaches the kernel. |

---

## 3. Prompt injection

**Scenario:** Content retrieved by the agent (web pages, file contents, tool
outputs) contains adversarial instructions that redirect the agent away from
the original task.

| Aspect | Detail |
|---|---|
| **Mechanism** | Three layers: (S1) `classifierGuardrail` — runs a separate model call to classify task/output for injection; (S2) `intentAlignmentGuardrail` — checks each proposed tool action against the original task before execution; (S3) `codeGuardrail` — static pattern scan of generated code before it enters the kernel. |
| **Default behaviour** | No guardrails are wired by default — enabling them requires explicit construction. `isUntrusted: true` can be set on `ToolUseStep` to tag external-origin content in history. |
| **How to harden** | Wire `classifierGuardrail` as an `InputGuardrail` and `OutputGuardrail`. Set `onError: "closed"` for fail-closed behaviour on classifier failures. Use `intentAlignmentGuardrail` as a `ToolGuardrail` for high-privilege tools. Pin the `systemPrompt` so the original instructions cannot be overwritten by appended user content. |
| **What is NOT covered** | No classifier is 100% accurate. Use guardrails as one layer in a defence-in-depth stack, not as a sole gate. A sophisticated adversary with knowledge of the classifier model's policy may craft bypasses. |

---

## 4. Result injection (build-result forgery)

**Scenario:** An attacker forges a build result payload on the
`/build-result` endpoint to corrupt the RLAIF training signal — making a
failing branch appear to pass, which introduces low-quality data into the
ranked training set.

| Aspect | Detail |
|---|---|
| **Mechanism** | Build-result nonce. When `buildResultsKv` is configured, the worker writes a one-time nonce into KV at job dispatch time. The `/build-result` callback must present the correct nonce; mismatched or missing nonces are rejected with HTTP 403. |
| **Default behaviour** | If `buildResultsKv` is not configured, nonce checking is skipped (compatible with local dev). |
| **How to harden** | Configure `buildResultsKv` in all production deployments. Set a short nonce TTL (default: 1 hour). Validate `objective_score` range server-side — scores outside `[0, 1]` should be rejected before they enter the ranking pipeline. |
| **What is NOT covered** | An attacker with valid KV access can still write forged nonces. KV access must be restricted to the worker's service binding only — do not expose the KV namespace directly. |

---

## 5. State pollution (cross-session data access)

**Scenario:** Agent session A writes files to its workspace; agent session B
reads them without authorisation, leaking another user's code or context.

| Aspect | Detail |
|---|---|
| **Mechanism** | `SessionKvStore` namespaces every KV key under a session prefix derived from `X-Session-Id`. A session can only read and write keys within its own prefix. The `allowedReadPaths` and `allowedWritePaths` in `CapabilityManifest` are further scoped to the session's workspace directory at kernel construction time. |
| **Default behaviour** | Each session's files are stored under `session:<id>:...`; a different `sessionId` cannot reach another session's prefix. |
| **How to harden** | Require `X-Session-Id` on all endpoints (see [deployment-checklist.md](deployment-checklist.md)). Do not allow clients to supply arbitrary session IDs — generate them server-side and bind them to authenticated user identities. Set `allowLocalSessionFallback: false` in production to reject requests that omit `X-Session-Id`. |
| **What is NOT covered** | If two authenticated users share a session ID (e.g. a collaboration feature), they share the same namespace by design. Cross-user isolation at the application layer is the caller's responsibility. |

---

## 6. Data exfiltration (env vars and secret files)

**Scenario:** The LLM generates code that reads `process.env.API_KEY` or
scans for `.env` files, then exfiltrates the values via an outbound HTTP call.

| Aspect | Detail |
|---|---|
| **Mechanism** | Two interlocking controls: (a) `CapabilityManifest.env` is an explicit value allow-list, not a `process.env` pass-through. The kernel never sees the host environment. (b) `CapabilityManifest.allowedHosts` controls outbound network. An empty `allowedHosts` means no network call can succeed even if code attempts one. |
| **Default behaviour** | `env` is absent → no env access. `allowedHosts` is `[]` → no network. Sandboxed code has no route to exfiltrate anything. |
| **How to harden** | Keep `allowedHosts` to the minimum set of specific domains required. Avoid wildcards (`*`) in production. Add a `redactPostHook` to strip API key patterns from tool outputs before they reach the agent's context window. Use `codeGuardrail` with a custom pattern list to block `process.env` references in generated code. |
| **What is NOT covered** | Values explicitly placed in `CapabilityManifest.env` are accessible to sandboxed code by design. Rotate secrets that are exposed via `env` on a per-session basis rather than sharing long-lived values across sessions. |

---

## Summary: default security posture

| Control | Default | Production recommendation |
|---|---|---|
| Kernel isolation | `JsKernel` (Node `vm`) | `QuickJSKernel` or `WasmtimeKernel` |
| Network | `allowedHosts: []` (deny-all) | Keep deny-all; add specific domains |
| Filesystem | `allowedReadPaths/WritePaths: []` (deny-all) | Scope to `/workspace/<sessionId>` |
| Env access | No `env` field (deny-all) | Inject only session-scoped tokens |
| Write approval | `PolicyPresets.permissive()` | `PolicyPresets.strict()` or `balanced()` |
| Prompt injection | No guardrails wired | Wire `classifierGuardrail` + `intentAlignmentGuardrail` |
| Session isolation | `SessionKvStore` prefix namespacing | Require `X-Session-Id`; server-generated IDs |
| Build-result integrity | Nonce disabled without `buildResultsKv` | Configure `buildResultsKv` |
| Audit trail | `EventLog` emits all events | Persist to KV; configure OTel bridge |

---

*Last reviewed: 2026-06-23. Scope: wasmagent-js kernel + agent framework. Platform security (Cloudflare Workers, KV durability, DDoS) is covered by Cloudflare documentation.*
