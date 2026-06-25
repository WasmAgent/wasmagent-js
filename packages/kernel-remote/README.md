# /kernel-remote

> **Maturity: stable** — semver-compatible API; breaking changes require a major bump.

Remote sandbox kernel — execute agent code in E2B, Cloudflare Sandbox, or any HTTP-driven microVM.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install /kernel-remote /core
```

## Usage

```ts
import { RemoteSandboxKernel } from "/kernel-remote";

const kernel = new RemoteSandboxKernel({
  endpoint: process.env.SANDBOX_URL!,  // E2B / CF Sandbox / your own
  apiKey: process.env.SANDBOX_KEY!,
});
```

Use this tier when agents need real shell access, npm install, or compilation chains —
i.e. things WASM kernels structurally cannot provide.

See the [kernel decision tree](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md).

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
