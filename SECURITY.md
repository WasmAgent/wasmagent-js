# Security policy — agentkit-js

## Reporting a vulnerability

Please report security issues privately to the repository owner. Do
not file a public issue for an exploitable vulnerability.

## Threat model

agentkit-js is a **library** — a runtime + tools + components used
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

### `@agentkit-js/ui-cards-react/src/D2Card.tsx` — iframe sandbox

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

- `@agentkit-js/kernel-quickjs` — pure JS in WASM. No DOM, no
  filesystem, no network. Sandbox is the WebAssembly boundary.
- `@agentkit-js/kernel-pyodide` — CPython in WASM. No network, no
  filesystem outside Pyodide's in-memory FS. Imports limited to what
  pyodide.loadPackage allows.
- `@agentkit-js/kernel-wasmtime` — Wasmtime sandbox; consumer must
  configure WASI capabilities explicitly. The default exposes no
  filesystem, no network, no env vars.
- `@agentkit-js/kernel-remote` — runs against a user-supplied HTTP
  endpoint; sandbox is whatever that endpoint enforces. **Consumers
  must trust their remote.**

### Browser tools

`@agentkit-js/tools-browser` (CDP + Playwright) executes arbitrary
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

`@agentkit-js/cloudflare-worker` ships:

- HMAC-SHA-256 webhook signing — recipients should verify the
  signature.
- JWT verifier — validates `sub` presence and `nbf` (with 60s clock
  skew) in addition to expiry/issuer/audience.
- KV-backed sliding-window rate limiter — **fails closed** when the
  KV value is malformed or wrong shape; it does not silently reset
  to zero. Run-time integrity check protects against drive-by
  corruption attacks.

## Defense in depth

For consumer apps using agentkit-js:

- Run JWT verification *before* model invocation, not after.
- Enforce `Origin` / CORS allow-list at the edge, not in worker
  code (worker code is best-effort; CDN edges are reliable).
- Cap per-request input size; bscode caps task at 16 KB.
- Don't compose `DEBUG_LEAK_INPUTS` or any verbose-logging fragment
  into production prompts.
- If you build your own consumer, audit your composition — the
  reusable fragments are deliberately small primitives, but your
  app's combination of them is what reaches the model.
