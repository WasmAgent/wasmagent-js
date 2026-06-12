# @agentkit-js/ag-ui

AG-UI (inbound) HTTP transport for agentkit-js agents — frame protocol + streaming.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work while the upstream AG-UI protocol stabilizes and demand signals (organic downloads, integration requests) come in. See [maintenance tiers](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install @agentkit-js/ag-ui @agentkit-js/core
```

## Usage

Expose any agent over the [AG-UI](https://github.com/ag-ui-protocol/ag-ui) frame protocol so
front-ends and agent IDEs can drive runs over a standard transport.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
