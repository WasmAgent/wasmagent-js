# @agentkit-js/kernel-quickjs

QuickJS-in-WASM kernel — sandboxed JavaScript, edge-safe, no `node:vm` required.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/kernel-quickjs @agentkit-js/core quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
```

## Usage

```ts
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const kernel = new QuickJSKernel();
const result = await kernel.run(`[1,2,3].reduce((a,b) => a+b, 0)`);
console.log(result.output); // 6
```

Drop-in replacement for `VmKernel` on **Cloudflare Workers** (which forbids `node:vm`),
Vercel Edge, Deno Deploy, and any environment where you want true language-level sandboxing
without spinning up a microVM.

See the [kernel decision tree](https://github.com/telleroutlook/agentkit-js/blob/main/docs/kernels/comparison.md).

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
