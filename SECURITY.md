# Security policy — wasmagent

## Reporting a vulnerability

Please report security issues privately to the repository owner. Do
not file a public issue for an exploitable vulnerability.

## Threat model

wasmagent is a **library** — a runtime + tools + components used
by downstream applications (bscode, other consumer agents). The
library is not deployed; it ships into someone else's app.

The trust boundary is:

- **Library author (us)** — controls all source under `packages/`.
- **App author (consumer)** — wires up models, tools, kernels, UI
  components into a deployable app. Decides which fragments to
  compose, which kernels to enable, which model keys to inject.
- **End user (theirs)** — talks to the deployed app.

Most security decisions are the consumer's responsibility (where to
store API keys, who is allowed to call `/run`, what session ids to
trust). Our responsibility is to give them safe primitives.

## Sandbox decisions in shipped components

### `@wasmagent/ui-cards-react/src/D2Card.tsx` — iframe sandbox

The D2 card renders compiled D2 SVG inside an iframe with:

```
sandbox="allow-scripts"
```

That's it — no `allow-same-origin`, no `allow-forms`, no
`allow-modals`. The iframe only runs a small postMessage script
(rendered-height reporter) wrapping the compiled SVG output. With a
`null` origin and no form/modal capability, a maliciously-crafted D2
input cannot:

- read the host page's cookies, localStorage, or sessionStorage
- access the host page's DOM (top, parent are cross-origin from the
  iframe's perspective)
- submit forms to arbitrary endpoints
- pop confirm/alert dialogs

**The combination of `allow-scripts` + `allow-same-origin` is
explicitly avoided here.** Chrome warns that combination can escape
the sandbox; we don't use it. Apps that *do* combine them (e.g. the
HTML preview pane in bscode) accept that risk for capability
reasons; D2Card does not need those capabilities, so it does not
take them.

### Kernels

- `@wasmagent/kernel-quickjs` — pure JS in WASM. No DOM, no
  filesystem, no network. Sandbox is the WebAssembly boundary.
- `@wasmagent/kernel-pyodide` — CPython in WASM. No network, no
  filesystem outside Pyodide's in-memory FS. Imports limited to what
  pyodide.loadPackage allows.
- `@wasmagent/kernel-wasmtime` — Wasmtime sandbox; consumer must
  configure WASI capabilities explicitly. The default exposes no
  filesystem, no network, no env vars.
- `@wasmagent/kernel-remote` — runs against a user-supplied HTTP
  endpoint; sandbox is whatever that endpoint enforces. **Consumers
  must trust their remote.**

### Browser tools

`@wasmagent/tools-browser` (CDP + Playwright) executes arbitrary
JS in a browser the agent controls. **Never point these at a
browser session that has the user's logins** — the agent can
exfiltrate cookies. They're meant for fresh, isolated browser
contexts (Playwright's `browser.newContext()`, a CDP endpoint
spawned for the run).

The Playwright `extract()` re-throws on per-selector failures
(rather than returning `""`), so the calling agent sees errors
instead of silently inferring "no matches". CDP `Runtime.evaluate`
calls surface `exceptionDetails` so a thrown page error doesn't
silently look like an empty success.

### Cloudflare Worker integration

`@wasmagent/cloudflare-worker` ships:

- HMAC-SHA-256 webhook signing — recipients should verify the
  signature.
- JWT verifier — validates `sub` presence and `nbf` (with 60s clock
  skew) in addition to expiry/issuer/audience.
- KV-backed sliding-window rate limiter — **fails closed** when the
  KV value is malformed or wrong shape; it does not silently reset
  to zero. Run-time integrity check protects against drive-by
  corruption attacks.

## Defense in depth

For consumer apps using wasmagent:

- Run JWT verification *before* model invocation, not after.
- Enforce `Origin` / CORS allow-list at the edge, not in worker
  code (worker code is best-effort; CDN edges are reliable).
- Cap per-request input size; bscode caps task at 16 KB.
- Don't compose `DEBUG_LEAK_INPUTS` or any verbose-logging fragment
  into production prompts.
- If you build your own consumer, audit your composition — the
  reusable fragments are deliberately small primitives, but your
  app's combination of them is what reaches the model.

## Sandbox escape — disclosure SLA (A6, 2026-06)

Because we ship a multi-tier sandbox and explicitly market it as the
foundation of `code-mode` (see `docs/guides/code-mode.md`), users
need a stronger commitment than "report it privately and we'll get
to it."

For reports affecting **`JsKernel` / `VmKernel` / `QuickJSKernel` /
`PyodideKernel` / `WasmtimeKernel` / `RemoteSandboxKernel`** that
demonstrate any of the following — we treat as **P0**:

1. Code running inside a kernel that bypasses
   `CapabilityManifest.allowedHosts` to reach an arbitrary external
   host.
2. Code running inside a kernel that reads or writes a path outside
   `allowedReadPaths` / `allowedWritePaths` (note: symlinks under an
   allowed prefix are explicitly out-of-scope per the
   `assertPathAllowed` docblock).
3. Code that breaks out of the kernel's process / linear-memory
   isolation entirely — i.e. observes or mutates host process
   memory, environment variables not in `capabilities.env`, or
   files unreachable through the documented FS bridge.
4. A timeout / memory-limit bypass that lets a single
   `kernel.run()` consume more wall-clock or memory than the
   documented `cpuMs` / `memoryLimitBytes` honouring matrix permits
   (with the matrix's `⚠️ best-effort` columns excluded; those are
   pre-disclosed as best-effort).

**P0 SLA:**

- Acknowledgement within 48 hours.
- Mitigation strategy or workaround within 7 days.
- Patched release within 30 days; affected users notified via
  GitHub Security Advisory.

We will credit reporters in the advisory unless they request
otherwise.

For reports outside the matrix above (e.g. fingerprinting,
side-channel timing leaks, denial-of-service against the host
process via heavy WASM compilation), the timelines are
best-effort — track on the issue.

## Public roadmap

See [`ROADMAP.md`](./ROADMAP.md) for what we are building and why.
Significant new sandbox features land via RFC PRs against
`docs/rfcs/`; the discussion is the audit trail.

## OWASP Agentic Top 10 + regulatory mapping

For procurement teams asking "which OWASP Agentic Applications Top 10
risks does `CapabilityManifest` cover, and where does it stop?", see
[`docs/security/capability-manifest-owasp.md`](./docs/security/capability-manifest-owasp.md).

That document maps each of the 10 risk categories (goal hijacking,
tool misuse, identity abuse, memory poisoning, cascading failures,
rogue agents, excessive agency, data exfiltration, insecure tool
chains, cascading misconfigurations) to the specific
`CapabilityManifest` field or kernel mechanism that enforces it,
**including what we explicitly do not cover** (5 boundaries
acknowledged in §5 of that document).

It also includes:

- A side-by-side comparison with Microsoft Agent Governance Toolkit
  (2026-04, MIT) — wasmagent is the **enforcement + isolation**
  layer, the toolkit is the **policy decision** layer; they
  compose, neither replaces the other.
- Mapping to EU AI Act Articles 14 / 15 / Annex IV, Colorado AI
  Act (executable 2026-06), ISO/IEC 42001.
- The protocol-layer authorization gap that `CapabilityManifest`
  fills (MCP 2026-06 and A2A both delegate authorization to
  implementations).

This is not a compliance attestation; it is documentation of the
primitives we ship. Auditors and risk officers welcome — see
"Reporting a vulnerability" above for the disclosure channel.
