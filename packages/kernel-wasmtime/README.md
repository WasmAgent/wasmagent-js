# @agentkit-js/kernel-wasmtime

True WASM sandbox via Javy + WASI — language-level isolation with zero `node:vm`.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/kernel-wasmtime @agentkit-js/core
```

## Usage

Compile JavaScript to WebAssembly via [Javy](https://github.com/bytecodealliance/javy) and run
it under a WASI host. Strongest sandboxing tier short of a microVM.

> Requires the `javy` CLI on your build environment.

See the [kernel decision tree](https://github.com/telleroutlook/agentkit-js/blob/main/docs/kernels/comparison.md).

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
