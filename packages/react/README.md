# /react

> **Maturity: beta** — API shape may change in minor versions; changes announced in CHANGELOG.

React hook — `useAgentRun()` for streaming SSE agent events in Next.js / React apps.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install /react /core
```

## Usage

```tsx
import { useAgentRun } from "/react";

const { events, finalAnswer, isRunning } = useAgentRun({ url: "/api/run" });
```

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
