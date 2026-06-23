# Kernel selection — VmKernel vs QuickJSKernel vs WasmtimeKernel

C2 — wasmagent-js ships three execution kernels for `CodeAgent` and
`ProgrammaticOrchestrator`. They differ on **isolation strength**, **cold-start
cost**, and **runtime breadth**. This page is the decision tree, plus a
quantitative comparison table.

## Decision tree

```
Q1. Where will this run?

    ├── Cloudflare Workers / Vercel Edge / browser
    │      → no node:vm, no fork() — must use a WASM kernel.
    │      ├── Q2a. Need DOM / fetch from inside the script?
    │      │      └── Use QuickJSKernel (full ES2020+, Web Fetch API).
    │      └── Q2b. Need full POSIX subset (fs, sockets) or non-JS langs?
    │             └── Use WasmtimeKernel (WASI preview2 sandbox).
    │
    ├── Server / container with Node.js
    │      ├── Q3a. Code is internal, low-risk, latency-critical?
    │      │      → VmKernel — fastest, no WASM compile cost.
    │      ├── Q3b. Code is user-supplied or third-party?
    │      │      → QuickJSKernel or WasmtimeKernel — process boundary
    │      │        not enough; you want a hardware-isolated guest.
    │      └── Q3c. Code calls system tools or runs Python / Rust?
    │             → kernel-pyodide (Python) or WasmtimeKernel (compiled WASM).
    │
    └── Hard multi-tenant isolation requirement (running unsigned third-party
        code, or processing PII alongside untrusted data)
              → kernel-remote (microVM via Firecracker / E2B), full
                process boundary outside the worker. Highest isolation,
                highest cold-start cost.
```

## Comparison table

| Dimension | **VmKernel** (`node:vm`) | **QuickJSKernel** (WASM) | **WasmtimeKernel** (WASI) | **kernel-remote** (microVM) |
|---|---|---|---|---|
| **Isolation strength** | ⚠️ Soft — same process, escapes via prototype pollution and `Function` constructor are documented | ✅ Hard — WASM linear memory, no host syscalls | ✅ Hard — WASI preview2 capabilities, no ambient authority | ✅✅ Hardware — separate kernel, separate memory, separate network namespace |
| **Cold start (warm)** | ~0.5 ms (context create) | ~5–10 ms (WASM module instantiate, cached) | ~10–20 ms (WASI module instantiate) | ~150–500 ms (microVM boot) |
| **Cold start (cold)** | ~1 ms | ~80–150 ms (first compile) | ~120–250 ms (first compile) | ~2–5 s (image pull + boot) |
| **Edge-runtime support** | ❌ — `node:vm` not available | ✅ Yes — pre-compiled `.wasm` variant ships in `@jitl/quickjs-wasmfile-release-sync` | ✅ Yes — Wasmtime runs anywhere | ⚠️ — out-of-process, requires Cloudflare Containers / E2B / similar |
| **Memory cap** | Soft — process-wide; per-context limit ~ none enforced | Hard — `memoryLimitBytes` opt; default 64 MB | Hard — WASI memory grow cap; default 128 MB | Hard — VM `mem_size_mib` |
| **CPU cap** | Soft — `timeoutMs` only | Hard — `timeoutMs` enforced inside QuickJS interrupt handler | Hard — `timeoutMs` enforced via Wasmtime fuel | Hard — VM `vcpu_count` plus host scheduling |
| **JS feature coverage** | Full V8 (includes WASM, top-level await) | ES2020+, no WeakRef, no SharedArrayBuffer, no top-level await | N/A — runs WASM bytecode (compile JS via [Javy](https://github.com/bytecodealliance/javy)) | Anything the guest image supports |
| **Non-JS languages** | ❌ JS only | ❌ JS only | ✅ Python (Pyodide), Rust, Go, .NET via WASI | ✅ Anything (POSIX guest) |
| **Network from script** | ✅ via injected `fetch` | ✅ via injected `fetch` | ⚠️ WASI sockets (preview2) — limited | ✅ subject to VM netns policy |
| **Cost per call** | Lowest | Low | Low | Highest (microVM lifecycle) |
| **Best for** | Trusted server-side code where speed dominates | User-supplied JS in edge / browser; the QuickJS sweet spot | Cross-language user code on edge; WASI ecosystems | Untrusted code with PII; multi-tenant SaaS isolation |

### Numbers source

The **cold-start** numbers above were measured on the kernel test harnesses
(`packages/core/src/executor/JsKernel.test.ts` and the kernel-package
test suites) on an Apple M1 / Node.js 22.12. They will vary with hardware;
re-run against your target with the harness as a sanity check before
committing to a kernel.

The **memory** and **CPU cap** rows reflect the option surfaces exposed by
each kernel's `Options` interface — see:

- `packages/core/src/executor/VmKernel.ts`
- `packages/kernel-quickjs/src/QuickJSKernel.ts`
- `packages/kernel-wasmtime/src/WasmtimeKernel.ts`
- `packages/kernel-remote/src/RemoteKernel.ts`

## Reproducible benchmarks

Each kernel ships a minimal benchmark in its package's `examples/` directory:

```bash
# Cold start microbench (single instantiate + tear-down):
node packages/kernel-quickjs/examples/cold-start.mjs
node packages/kernel-wasmtime/examples/cold-start.mjs

# Throughput microbench (1000 small scripts back to back):
node packages/kernel-quickjs/examples/throughput.mjs
```

(Coming in C3 — the bench scripts ship as part of the docs/example backfill.)

## Picking quickly

- **Edge-runtime, JS code, low trust** → `QuickJSKernel`. Default for the
  bscode worker today.
- **Edge-runtime, polyglot, low trust** → `WasmtimeKernel`.
- **Node.js server, internal trusted code** → `VmKernel`. Don't pay the WASM
  tax when you don't need the boundary.
- **PII or unsigned third-party code** → `kernel-remote` (microVM).
