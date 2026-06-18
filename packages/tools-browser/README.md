# /tools-browser

Browser automation tools — Playwright session + CDP-bridge session, 5 tools (navigate / click / fill / screenshot / extract).

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install /tools-browser /core
```

## Usage

Two interchangeable sessions: `PlaywrightSession` for local headless work,
`CdpSession` for connecting to an existing browser via the Chrome DevTools Protocol
(works inside Cloudflare Browser Rendering, browserless.io, or your own instance).

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
