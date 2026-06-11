# @agentkit-js/devtools

Time-travel debugger — `EventLogReplay` engine + opt-in `<DevTools />` React UI.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/devtools @agentkit-js/core
```

## Usage

Step-replay any `EventLog` and **fork from any step**. The React surface is opt-in via
the `/react` subpath (peer-depends on React, but never required for the core engine).

```tsx
import { EventLogReplay } from "@agentkit-js/devtools";
import { DevTools } from "@agentkit-js/devtools/react";
```

See [docs/guides/devtools.md](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/devtools.md).

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
