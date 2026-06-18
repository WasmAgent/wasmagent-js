# /kernel-pyodide

CPython-in-WASM kernel (Pyodide) — run real Python code from agents on Node, Bun, and CF Workers.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install /kernel-pyodide /core pyodide
```

## Usage

```ts
import { PyodideKernel } from "/kernel-pyodide";

const kernel = new PyodideKernel();
const result = await kernel.run(`import math; print(math.gcd(2024, 56))`);
console.log(result.logs); // ["8"]
```

> ⚠️ **Memory budget on edge runtimes** — Pyodide's WASM image and Python heap together are
> ~50–80 MB resident. Cloudflare Workers' free tier (~128 MB) leaves only thin headroom for
> user code; for memory-heavy workloads use [`kernel-wasmtime`](../kernel-wasmtime) or
> [`kernel-remote`](../kernel-remote) microVMs.

See the [kernel decision tree](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md).

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
