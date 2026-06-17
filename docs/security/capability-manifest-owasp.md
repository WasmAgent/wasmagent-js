# `CapabilityManifest` ↔ OWASP Agentic Top 10 — Coverage Matrix

> **Audience:** security architects, AI risk officers, procurement evaluating "agent platforms" against OWASP Agentic Applications Top 10 (2025-12) and EU AI Act / Colorado AI Act / ISO 42001 control families.
>
> **Question this doc answers:** for each of the 10 OWASP risk categories, *what is the runtime primitive in agentkit-js that enforces it, and where exactly does it stop?*
>
> **Posture (read this first):** `CapabilityManifest` is **not a governance product**. It is the *deny-all, runtime-enforced* layer that a governance product calls into to actually stop a violation in flight. Microsoft's Agent Governance Toolkit (2026-04-02, MIT) decides whether an action *should* run; agentkit's kernel decides whether it *can* — and isolates the blast radius if it does. The two layers compose; neither replaces the other.

---

## 0. The primitive itself (one-paragraph spec)

`CapabilityManifest` ([`packages/core/src/executor/types.ts`](../../packages/core/src/executor/types.ts)) is a single object every kernel honours uniformly:

```ts
interface CapabilityManifest {
  allowedHosts: string[];          // outbound HTTP allow-list (deny-all default)
  allowedReadPaths: string[];      // FS read prefixes (deny-all default)
  allowedWritePaths: string[];     // FS write prefixes (deny-all default)
  extraCapabilities: string[];     // named caps (e.g. "tool:web_search")
  env?: Readonly<Record<string, string>>;  // explicit value allow-list (NOT host pass-through)
  cpuMs?: number;                  // hard per-invocation deadline
  memoryLimitBytes?: number;       // soft per-invocation memory ceiling
}
```

Every absent field = an empty allow-list = nothing permitted. This is the deny-all property. The same manifest is honoured by `JsKernel`, `QuickJSKernel`, `PyodideKernel`, `WasmtimeKernel`, and `RemoteSandboxKernel`. Honouring matrix in [`types.ts`](../../packages/core/src/executor/types.ts).

---

## 1. Coverage matrix

For each OWASP Agentic Top 10 risk:

- **What it is** (one line).
- **Primitive that enforces it** (`CapabilityManifest` field or kernel mechanism).
- **Where the line is** (what we stop and what we do not).
- **What still belongs to the consumer** (governance/product layer above us).

| # | OWASP risk | Primitive that enforces | Where the line is |
|---|-----------|-----------------------|------------------|
| **1** | **Goal hijacking** — adversarial input rewrites the agent's objective | *Outside the kernel boundary by design.* Kernel does not see the agent's plan | Mitigation: governance layer (e.g. MS Agent Governance Toolkit) does prompt-injection detection / policy-on-paths; agentkit's job is that even if the goal flips, the kernel still refuses unauthorised tool/network/FS calls — `extraCapabilities`, `allowedHosts`, `allowedReadPaths/WritePaths` all remain in force regardless of the LLM's reasoning. |
| **2** | **Tool misuse / unauthorised tool invocation** | `extraCapabilities: string[]` — the kernel only resolves named tools present in this allow-list | A tool not listed cannot be called from inside sandboxed code, full stop. *Not covered:* tool selection inside the LLM's reasoning trace before the call reaches the kernel — that's the governance layer's job. |
| **3** | **Identity abuse / credential misuse** | `env?: Readonly<Record<string, string>>` — explicit value allow-list, not a `process.env` pass-through. The kernel never sees host environment | Sandboxed code sees only the values explicitly placed in `env`. The host's API keys, DB passwords, OAuth refresh tokens cannot leak into sandboxed execution unless the consumer explicitly puts them there. *Not covered:* what the consumer chooses to put in `env` (and whether that's appropriate per session) — see Gravitee's State of AI Agent Security 2026: only 22% of agents have independent identity. The primitive supports independent identity; using it remains a consumer choice. |
| **4** | **Memory poisoning** — adversarial inputs persist into long-term memory and re-corrupt later runs | *Partial.* Kernel `reset()` clears cross-step variables. Memory persistence (`@agentkit-js/memory`, `MemoryBlockSet`) is a separate package | The kernel guarantees no implicit cross-session state in WASM linear memory after `reset()`. *Not covered:* what `MemoryAdapter` writes to durable storage, and whether the consumer validates incoming memory blocks. Recommended pairing: governance-layer input validation + `MemoryBlockSet` size caps. |
| **5** | **Cascading failures / runaway loops** | `cpuMs: number` (hard deadline, lower-of with `KernelOptions.timeoutMs` — defence-in-depth) and `memoryLimitBytes` (soft ceiling, hard on QuickJS/Wasmtime/Remote, advisory on Pyodide/Js) | A single kernel invocation cannot exceed `cpuMs` real time. *Not covered:* application-level retry storms — that's the consumer's orchestration layer. agentkit's `WorkflowEngine` ([`packages/core/src/workflow/`](../../packages/core/src/workflow/)) provides resumable, terminable workflow steps that compose with this limit. |
| **6** | **Rogue agents** — an unauthorised agent inserts itself into a multi-agent conversation | *Outside the kernel boundary.* Mitigation belongs to the agent-id / session layer | Kernel does not authenticate the calling agent. *We support it indirectly:* `RemoteSandboxKernel` requires consumers to attach their own auth headers, and the `a2a` package's identity primitives (separate package) compose with `CapabilityManifest` per-session. |
| **7** | **Excessive agency / over-broad tool surface** | The combination of `allowedHosts` (network), `allowedReadPaths`/`allowedWritePaths` (filesystem), `extraCapabilities` (named tools), `env` (secrets), `cpuMs` / `memoryLimitBytes` (resources) — each defaulting to deny-all | The blast radius of a compromised tool call is bounded by what the manifest grants. *Not covered:* whether the manifest itself was over-granted at construction time — that's the consumer's policy layer (and the place where a governance product's "least privilege" recommendation feeds in). |
| **8** | **Data exfiltration** | `allowedHosts: string[]` — empty = network is fully off | Sandboxed code with `allowedHosts: []` cannot DNS-resolve, cannot fetch, cannot WebSocket. WASM kernels have no socket primitive at all. *Not covered:* exfiltration via *allowed* hosts (e.g. agent uploads stolen data to the same documentation host it's allowed to read). Mitigation: keep `allowedHosts` to specific paths if your kernel transport supports it, plus governance-layer egress monitoring. |
| **9** | **Insecure tool chains** — agent invokes a downstream tool that itself executes untrusted code | Kernel choice + `extraCapabilities` namespacing. The 5 kernels ladder from "Node `vm`" (JsKernel) to "Wasmtime" (full WASM) to "remote" (E2B) — see [`docs/kernels/comparison.md`](../kernels/comparison.md) | Consumer picks the isolation tier matching their threat model. *Not covered:* the consumer running a high-privilege tool inside a low-tier kernel — picking the right kernel for the threat is a deployment decision, not a runtime check. |
| **10** | **Cascading misconfigurations** — a downstream agent inherits a more permissive policy than intended | `CapabilityManifest` is **not** mergeable with `Object.assign`. Each call to `kernel.run(code, capabilities)` *replaces*, never extends, the prior manifest | A child agent never silently inherits a parent's `allowedHosts`. The consumer must explicitly construct a new manifest per call. *Not covered:* whether the consumer's orchestration layer constructs that manifest correctly — but the primitive forces them to think about it (no implicit inheritance). |

---

## 2. Compared to: Microsoft Agent Governance Toolkit

The toolkit (2026-04-02, MIT) is the closest comparable open-source primitive. It is **complementary**, not competing:

| Capability | MS Agent Governance Toolkit | agentkit-js `CapabilityManifest` + kernels |
|------------|----------------------------|--------------------------------------------|
| OWASP Agentic Top 10 coverage | 10/10 (declared) | 7/10 directly enforced; 3/10 boundary-acknowledged (1 / 4 / 6) |
| Framework-neutral | ✅ (20+ adapters) | ✅ (5 kernels, framework-agnostic API) |
| Determinism | ✅ deterministic policy decisions | ✅ deterministic — `CapabilityManifest` is data, not code |
| p99 enforcement latency | < 0.1 ms | depends on kernel; typically < 1 ms (manifest check is a hashmap lookup before tool dispatch) |
| **Provides isolation** | ❌ — pure policy | ✅ — real WASM isolation (QuickJS/Pyodide/Wasmtime) |
| Decides "should it run?" | ✅ | (delegates to caller) |
| Decides "can it run?" | (delegates to runtime) | ✅ |
| Stops a violation in flight | only by being checked beforehand | ✅ — sandbox boundary halts execution |

**Recommended composition:** governance toolkit decides `should`, agentkit kernel enforces `can` and isolates the blast radius. A worked example is in [`examples/governance-toolkit-integration.md`](../../examples/governance-toolkit-integration.md) (placeholder — to be added 2026-Q3).

---

## 3. Compared to: protocol-layer authorization (MCP / A2A)

Both protocols solve **authentication** ("which agent is calling?") and explicitly delegate **authorization** ("what is this agent allowed to do?") to the implementation. See:

- *MCP specification 2026-06* (draft): authorization is "implementation-defined".
- *A2A specification* (Linux Foundation, 2026-Q1): authorization scopes per agent are implementation responsibility.
- arXiv 2601.02371 *Permission Manifests for Web Agents* — academic work in this exact gap.

`CapabilityManifest` is the implementation-side primitive that fills this gap: it is a *permission manifest* in the sense of the arXiv paper, but enforced at WASM boundary rather than at HTTP boundary. The `mcp-server` package ([`packages/mcp-server/`](../../packages/mcp-server/)) carries the manifest through MCP tool calls into kernel execution.

---

## 4. Regulatory mapping

For procurement teams evaluating against current regulation:

| Regulation / Standard | Article / Control | Primitive in agentkit-js |
|----------------------|-------------------|--------------------------|
| **EU AI Act** Art. 14 (human oversight) | High-risk system must allow human intervention | `WorkflowEngine` terminable contract + `cpuMs` deadline ([`packages/core/src/workflow/`](../../packages/core/src/workflow/)) |
| **EU AI Act** Art. 15 (accuracy / cybersecurity) | Robustness, resilience, security | Kernel boundary (WASM) + `CapabilityManifest` deny-all + `evals-runner` paired statistical accuracy reporting |
| **EU AI Act** Annex IV (technical documentation) | Document architecture, capabilities, limitations | This document + [`docs/kernels/comparison.md`](../kernels/comparison.md) + `api-stability.md` |
| **Colorado AI Act** (executable 2026-06) | Algorithmic discrimination prevention, transparency | Out of `CapabilityManifest` scope; supported by `evals-runner` Pareto reports including fairness axes when configured |
| **ISO/IEC 42001** (AI management systems) | A.6.1.2 (impact assessment), A.7.4.1 (data quality), A.8.2 (lifecycle) | `evals-runner` synthetic-fixture isolation (no train/test contamination), CI-gated reproducibility, public CHANGELOG |
| **OWASP Agentic Top 10** | (above 10 entries) | This document, §1 |

This mapping is **claims about the primitives we ship**, not a compliance audit. Procurement teams should pair this with their own attestation process; we are happy to participate in that process — see [`SECURITY.md`](../../SECURITY.md) §"Reporting and disclosure".

---

## 5. What we explicitly do NOT cover

A short, honest list. This is what a governance/product layer above us must own:

1. **Prompt-injection detection** — agentkit does not parse the agent's prompt for adversarial content. Use a governance toolkit.
2. **Decision logging / audit trail formatting** — kernels emit structured events (see [`packages/core/src/types/events.ts`](../../packages/core/src/types/events.ts)); transforming those into your SIEM's audit format is your code.
3. **Multi-tenant key management** — `env` accepts whatever values you put in it; rotating, vaulting, and per-session scoping of those values is your platform's job.
4. **Cross-agent identity** — `a2a` provides the agent-id primitive; pairing identities to manifests is a session-layer decision.
5. **Compliance attestation** — we provide architecture, threat model, and primitive documentation. We do not (and cannot) certify your *system* as EU AI Act compliant; that requires your full system context.

---

## 6. Verifying the claims in this document

Every "primitive" referenced in §1 is testable. The deny-all defaults are exercised by [`packages/core/src/executor/CapabilityManifest.test.ts`](../../packages/core/src/executor/) (placeholder — verify path during 2026-Q3 doc audit). To reproduce the honouring matrix:

```sh
git clone https://github.com/telleroutlook/agentkit-js
cd agentkit-js
bun install
bun run -F '@agentkit-js/core' test:capability
```

The matrix in [`packages/core/src/executor/types.ts`](../../packages/core/src/executor/types.ts) is the source of truth; this document is a derived view. If they disagree, the code wins — file an issue.

---

## 7. Changelog

- 2026-06-17 — Initial version. Authored in response to OWASP Agentic Top 10 (2025-12) + Colorado AI Act executable date (2026-06) + EU AI Act high-risk obligations (2026-08).

---

*Last reviewed: 2026-06-17. Next scheduled review: 2026-Q3 (post MCP 2026-06 spec + Q3 MCP/A2A interop). Open an issue if a regulatory or OWASP update lands before then.*
