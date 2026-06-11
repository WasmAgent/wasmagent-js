# @agentkit-js/react

React hook — `useAgentRun()` for streaming SSE agent events in Next.js / React apps.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/react @agentkit-js/core
```

## Usage

```tsx
import { useAgentRun } from "@agentkit-js/react";

const { events, finalAnswer, isRunning } = useAgentRun({ url: "/api/run" });
```

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
