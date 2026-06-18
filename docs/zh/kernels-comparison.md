# Kernel 选型 — VmKernel vs QuickJSKernel vs WasmtimeKernel

C2 — wasmagent 为 `CodeAgent` 和 `ProgrammaticOrchestrator` 提供三种执行 kernel。它们在**隔离强度**、**冷启动成本**、**运行时广度**上有差异。本页是决策树 + 量化对比表。

## 决策树

```
Q1. 在哪里跑？

    ├── Cloudflare Workers / Vercel Edge / 浏览器
    │      → 没 node:vm、没 fork() — 必须用 WASM kernel。
    │      ├── Q2a. 脚本里需要 DOM / fetch?
    │      │      └── 用 QuickJSKernel（完整 ES2020+、Web Fetch API）。
    │      └── Q2b. 需要完整 POSIX 子集（fs、socket）或非 JS 语言?
    │             └── 用 WasmtimeKernel（WASI preview2 沙箱）。
    │
    ├── 带 Node.js 的服务器 / 容器
    │      ├── Q3a. 内部代码、低风险、对延时敏感?
    │      │      → VmKernel — 最快、无 WASM 编译开销。
    │      ├── Q3b. 用户提供或第三方代码?
    │      │      → QuickJSKernel 或 WasmtimeKernel — 进程边界不够，
    │      │        要硬件隔离的 guest。
    │      └── Q3c. 代码调系统工具或跑 Python / Rust?
    │             → kernel-pyodide（Python）或 WasmtimeKernel（编译 WASM）。
    │
    └── 强多租户隔离要求（跑未签名第三方代码、或与不可信数据并放 PII）
              → kernel-remote（Firecracker / E2B 微 VM），完整进程边界
                位于 worker 之外。最高隔离，最高冷启动成本。
```

## 对比表

| 维度 | **VmKernel** (`node:vm`) | **QuickJSKernel** (WASM) | **WasmtimeKernel** (WASI) | **kernel-remote** (微 VM) |
|---|---|---|---|---|
| **隔离强度** | ⚠️ 软 — 同进程，原型污染和 `Function` 构造器逃逸有公开记录 | ✅ 硬 — WASM 线性内存、无主机 syscall | ✅ 硬 — WASI preview2 能力、无环境权限 | ✅✅ 硬件 — 独立 kernel、独立内存、独立网络命名空间 |
| **冷启动（热）** | ~0.5 ms（建上下文） | ~5–10 ms（WASM 模块实例化，已缓存） | ~10–20 ms（WASI 模块实例化） | ~150–500 ms（微 VM 启动） |
| **冷启动（冷）** | ~1 ms | ~80–150 ms（首次编译） | ~120–250 ms（首次编译） | ~2–5 s（拉镜像 + 启动） |
| **边缘运行时支持** | ❌ — 没有 `node:vm` | ✅ 是 — `@jitl/quickjs-wasmfile-release-sync` 内含预编译 `.wasm` | ✅ 是 — Wasmtime 哪里都跑 | ⚠️ — 进程外，需要 Cloudflare Containers / E2B / 类似 |
| **内存上限** | 软 — 进程级；context 级几乎无强制 | 硬 — `memoryLimitBytes` 选项；默认 64 MB | 硬 — WASI memory grow 上限；默认 128 MB | 硬 — VM `mem_size_mib` |
| **CPU 上限** | 软 — 仅 `timeoutMs` | 硬 — `timeoutMs` 在 QuickJS 中断处理中强制 | 硬 — 通过 Wasmtime fuel 强制 `timeoutMs` | 硬 — VM `vcpu_count` + 主机调度 |
| **JS 特性覆盖** | 完整 V8（包括 WASM、top-level await） | ES2020+、无 WeakRef、无 SharedArrayBuffer、无 top-level await | N/A — 跑 WASM 字节码（用 [Javy](https://github.com/bytecodealliance/javy) 编译 JS） | guest 镜像支持的任何 |
| **非 JS 语言** | ❌ 仅 JS | ❌ 仅 JS | ✅ Python（Pyodide）、Rust、Go、.NET（WASI） | ✅ 任何（POSIX guest） |
| **脚本内访问网络** | ✅ 注入 `fetch` | ✅ 注入 `fetch` | ⚠️ WASI sockets（preview2）— 受限 | ✅ 受 VM netns 策略限制 |
| **每次调用成本** | 最低 | 低 | 低 | 最高（微 VM 生命周期） |
| **最适合** | 速度优先的可信服务端代码 | 边缘 / 浏览器中的用户 JS；QuickJS 甜点 | 边缘上的跨语言用户代码；WASI 生态 | 含 PII 的不可信代码；多租户 SaaS 隔离 |

### 数字来源

上面**冷启动**数字基于 kernel 测试 harness（`packages/core/src/executor/JsKernel.test.ts` 和 kernel 包测试套件）在 Apple M1 / Node.js 22.12 上测得。会因硬件而异；选择前用 harness 在你的目标机器跑一遍做 sanity check。

**内存**和 **CPU 上限**行反映各 kernel `Options` 接口暴露的选项 —— 见：

- `packages/core/src/executor/VmKernel.ts`
- `packages/kernel-quickjs/src/QuickJSKernel.ts`
- `packages/kernel-wasmtime/src/WasmtimeKernel.ts`
- `packages/kernel-remote/src/RemoteKernel.ts`

## 可复现基准

每个 kernel 在它的包 `examples/` 目录里都附了最小基准：

```bash
# 冷启动 microbench（单次实例化 + 销毁）：
node packages/kernel-quickjs/examples/cold-start.mjs
node packages/kernel-wasmtime/examples/cold-start.mjs

# 吞吐 microbench（1000 个小脚本背靠背）：
node packages/kernel-quickjs/examples/throughput.mjs
```

（C3 即将到位 — bench 脚本会随 docs/example 一起补完。）

## 快速选择

- **边缘运行时、JS 代码、低信任** → `QuickJSKernel`。bscode worker 当前默认。
- **边缘运行时、多语言、低信任** → `WasmtimeKernel`。
- **Node.js 服务端、内部可信代码** → `VmKernel`。不需要边界就别付 WASM 税。
- **PII 或未签名第三方代码** → `kernel-remote`（微 VM）。
