# integration-smoke

Local-only end-to-end smoke scripts that drive the public `@wasmagent/*`
package surface across `worker_threads`, real WASM isolates, and HTTP.

> **Not run in CI.** The suite spins up real isolates, real HTTP servers, and
> real cross-package wiring. Wall-clock ≈ 1–2 min. CI's fast feedback comes
> from `bun run test` (vitest, in-process) and `examples/benchmarks/run-all.mjs`
> (token-counter benchmarks). This directory is the **pre-merge / pre-release
> sanity gate** — run it by hand against a fresh build before tagging or
> publishing.

## Quick start

```bash
cd examples/integration-smoke

# Run every script in order, summary at the end:
bun run all

# Or run one script at a time (script-id matches package.json):
bun run a1            # → bun a1-codemode.mjs
bun run edge:sandbox  # → bun edge-sandbox-escape.mjs
```

A non-zero exit from any script fails the runner. Each script self-contains
its assertions; failures print to stderr.

## What each script covers

The "A-something" scripts pin **strategic-line surfaces** (S1, S3, etc. from
the optimization briefs). The "edge-something" scripts target known boundary
patterns where unit tests tend to skip a corner.

### Strategic-line smokes

| Script | Strategic line | What it pins |
|---|---|---|
| `a1-codemode.mjs` | S1 / A1 | Drive `createCodeModeServer` over JSON-RPC like a real MCP host. Verifies `tools/list` publishes exactly `docs_search + execute_code`, the in-sandbox `callTool` chain works, and only the script's return value crosses back. |
| `a2-aisdk-mastra.mjs` | S1 / A2 | Verify `@wasmagent/aisdk` (`sandboxedJsTool`) and `@wasmagent/mastra-sandbox` (`agentkitMastraSandbox`) actually work end-to-end against the structurally-typed shapes those upstream SDKs expose. No `ai` / `@mastra/core` import — just the call shape. |
| `a4-studio-http.mjs` | S3 / A4 | Start the local Studio HTTP server (`agentkit devtools`), exercise `/api/rollup`, `/api/runs`, `/`. Asserts JSON shape and clean shutdown. |
| `a5-openai-compat.mjs` | S / A5 | Construct `GenericOpenAICompatModel` for the 5 documented recipes (Ollama, OpenRouter, AI Gateway, DeepSeek, Groq). No network — only that `capabilities` + `providerId` + extras land where each recipe doc claims they do. |
| `cross-kernel.mjs` | A1 | The cross-kernel contract: same `CapabilityManifest` produces the same observable surface in `JsKernel` and `QuickJSKernel`. Catches per-kernel drift the per-package unit tests can't see. |

### Edge-case smokes

| Script | What it pins |
|---|---|
| `edge-capability-boundaries.mjs` | `allowedHosts` glob edge cases, `allowedReadPaths` traversal attempts, `cpuMs`/`memoryLimitBytes` interaction. Every check can only fail if a real boundary bug exists. |
| `edge-codemode-adversarial.mjs` | The iterative-rerun protocol assumes scripts have predictable call-site shape across re-runs. Adversarial patterns: catching `PENDING_MARKER`, mutable-state loops over `callTool`, etc. |
| `edge-cross-package.mjs` | Wire 3+ packages together in non-trivial ways. Same kernel under `aisdk` `codeModeTool` and `mastra-sandbox` — both see the same capability-denial format. `mcp-server` fetchHandler against an `aisdk`-style downstream. `McpAgentServer` with a real `KvCheckpointer`-backed task store, round-trip across two server instances. |
| `edge-evals-runner.mjs` | `@wasmagent/evals-runner` end-to-end against a deterministic fake provider. No network, no token cost. Pins: one cell per `(model × seed × item)`, mean acc + Wilson CI, Pareto front, markdown report sections. |
| `edge-mcp-protocol.mjs` | MCP protocol fuzzing — malformed envelopes, adversarial `execute_code` inputs. Asserts the right JSON-RPC error code/shape rather than crashes or hangs. |
| `edge-sandbox-escape.mjs` | Sandbox escape vectors per kernel. For each kernel × each known escape pattern, assert the kernel either rejects the script or produces a value that proves the host process was NOT reached. |
| `edge-state-pollution.mjs` | Per-call isolation under sequential capability churn (cap → no-cap → different cap), `reset()` actually clearing user state, two concurrent `run()` on the same kernel not corrupting each other. |
| `edge-studio-robustness.mjs` | `agentkit devtools` with malformed / degenerate NDJSON event logs, plus the HTTP surface under concurrent / malformed / large requests. |

## Run order

`run-all.mjs` pins an order — cheap, no-IO scripts first (fast failure
signal), HTTP / MCP / Studio at the end. The order is asserted to cover every
`.mjs` in this directory, so adding a new smoke without registering it in
`ORDER` fails fast.

## When to add a new smoke here

- A new strategic line that ships a public package surface (`a*` script).
- A bug class that the per-package unit tests structurally can't catch
  (`edge-*` script).

When in doubt: if the bug requires running real WASM, real HTTP, or
multiple packages at once, it goes here. If it can run in `vitest`, it
goes in the relevant package's test directory.
