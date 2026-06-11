# @agentkit-js/kernel-remote

Remote sandbox kernel — execute agent code in E2B, Cloudflare Sandbox, or any HTTP-driven microVM.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/kernel-remote @agentkit-js/core
```

## Usage

```ts
import { RemoteSandboxKernel } from "@agentkit-js/kernel-remote";

const kernel = new RemoteSandboxKernel({
  endpoint: process.env.SANDBOX_URL!,  // E2B / CF Sandbox / your own
  apiKey: process.env.SANDBOX_KEY!,
});
```

Use this tier when agents need real shell access, npm install, or compilation chains —
i.e. things WASM kernels structurally cannot provide.

See the [kernel decision tree](https://github.com/telleroutlook/agentkit-js/blob/main/docs/kernels/comparison.md).

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
