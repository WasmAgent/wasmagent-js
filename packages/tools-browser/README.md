# @agentkit-js/tools-browser

Browser automation tools — Playwright session + CDP-bridge session, 5 tools (navigate / click / fill / screenshot / extract).

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/tools-browser @agentkit-js/core
```

## Usage

Two interchangeable sessions: `PlaywrightSession` for local headless work,
`CdpSession` for connecting to an existing browser via the Chrome DevTools Protocol
(works inside Cloudflare Browser Rendering, browserless.io, or your own instance).

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
