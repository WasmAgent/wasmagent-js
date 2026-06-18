# Code Mode — collapse 30+ MCP tools into one safe `execute_code`

> **Status**: shipped in `@wasmagent/mcp-server@0.3` (S1/A1, 2026-06).
> Designed against the same pattern Cloudflare's Code Mode MCP server (InfoQ,
> 2026-04), Red Hat codemode-lite (next.redhat.com, 2026-04), and Anthropic's
> "code execution with MCP" guide all converged on in 2026.

## Why code-mode

When an MCP host (Claude Code, Cursor, Copilot…) connects to a server that
publishes 30+ tools, every tool's name + description + JSON schema lands in
the model's prompt — even tools the model never calls. Codemode-lite measured
**53% token savings** simply by collapsing those tools behind a single
`run_python` entry and letting the model fetch docs JIT.

Code-mode in agentkit-js replaces that single `run_python` (which only RH ran
inside their own gVisor container) with **any agentkit `Kernel`** —
`QuickJSKernel`, `PyodideKernel`, `WasmtimeKernel`, or `RemoteSandboxKernel`.
The same `CapabilityManifest` (allowedHosts / allowedReadPaths /
allowedWritePaths / env / cpuMs / memoryLimitBytes) gates the sandbox
identically across language and isolation tier.

## What you ship

```ts
import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { createCodeModeServer, createFetchHandler } from "@wasmagent/mcp-server";

const tools = new ToolRegistry();
tools.register({ name: "search_docs", /* … */ });
tools.register({ name: "read_file", /* … */ });
// …40 more tools…

const server = createCodeModeServer({
  serverInfo: { name: "my-code-mode", version: "1.0.0" },
  tools,
  // QuickJSKernel for edge-safe execution; swap to RemoteSandboxKernel
  // (E2B / Cloudflare Sandbox) when you need full process isolation.
  kernel: new QuickJSKernel({ timeoutMs: 5_000 }),
  capabilities: {
    allowedHosts: ["api.example.com"],
    allowedReadPaths: ["/workspace"],
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "" },
  },
});

// Wire to HTTP — works in Node, Bun, Workers.
export default { fetch: createFetchHandler(server, { path: "/mcp" }) };
```

The host now sees **two** tools instead of forty:

- `docs_search(query?, names?)` — JIT-fetched type signatures and
  descriptions for the downstream tools. Always free of input schemas by
  default; pass `includeSchemas: true` to inline them.
- `execute_code({ code })` — runs a JS snippet in the kernel. The snippet
  may call `callTool(name, args)` against any registered tool; only the
  snippet's final return value crosses the wire.

## Token math

The headline result, from `examples/benchmarks/code-mode-tokens.mjs` (offline
accounting model, 2026-06):

| N tools | Direct MCP | Code-mode | Ratio | Savings |
| ------: | ---------: | --------: | ----: | ------: |
|      10 |       1530 |       474 | 31.0% |   69.0% |
|      30 |       3490 |       474 | 13.6% |   86.4% |
|     100 |      10350 |       474 |  4.6% |   95.4% |

The exact numbers depend on your tool docstring lengths and the host's
prefix-cache hit rate. The **shape** is what matters: direct MCP is O(N) on
the bootstrap, code-mode is O(1).

## Security policy face

Every kernel honours the same `CapabilityManifest`. The matrix
([core.executor.types.ts](../../packages/core/src/executor/types.ts)) records
which fields each kernel enforces natively vs falls back to best-effort:

|              field |     JsKernel | QuickJSKernel | PyodideKernel | WasmtimeKernel |     Remote |
| -----------------: | -----------: | ------------: | ------------: | -------------: | ---------: |
|       allowedHosts |            ✅ |             ✅ |             ✅ |              ✅ |          ✅ |
|   allowedReadPaths |            ✅ |       ✅ (fs†) |       ✅ (fs†) |        ✅ (fs†) |          ✅ |
|  allowedWritePaths |            ✅ |       ✅ (fs†) |       ✅ (fs†) |        ✅ (fs†) |          ✅ |
|                env |            ✅ |             ✅ |             ✅ |              ✅ |          ✅ |
|              cpuMs | ✅ (timeout) | ✅ (deadline) | ✅ (deadline) |   ✅ (deadline) | ✅ (per-call) |
|   memoryLimitBytes |       ⚠️ best |             ✅ |        ⚠️ best |              ✅ |          ✅ |

† FS access in WASM kernels lands on the host via an explicit `__fs__` bridge
that re-validates every call against the same allow-lists.

## When code-mode is not the right pick

- **Tool count < ~10**: bootstrap savings are too small to justify the JIT
  docs round-trip latency. Use direct MCP.
- **Tools with rich return objects you want the model to inspect verbatim**:
  in code-mode the model only sees `execute_code`'s final return value, so a
  multi-step "look at this object, then decide" workflow can be harder to
  steer than a tool/result chain. PTC (`ProgrammaticOrchestrator`) sometimes
  fits better — it's the same idea, but the script *is* the agent's main
  loop instead of one tool among others.
- **You're already paying for tool/result round-trips because you need the
  history visible to the model**: code-mode hides the intermediate steps.

## See also

- [`packages/mcp-server/src/codeMode.ts`](../../packages/mcp-server/src/codeMode.ts)
  — implementation, ~250 LOC.
- [`examples/benchmarks/code-mode-tokens.mjs`](../../examples/benchmarks/code-mode-tokens.mjs)
  — token-accounting harness; the report rolls up into `report-code-mode.md`.
- [`packages/core/src/executor/ProgrammaticOrchestrator.ts`](../../packages/core/src/executor/ProgrammaticOrchestrator.ts)
  — the in-kernel script runner code-mode delegates to.
