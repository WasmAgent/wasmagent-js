# browser-screenshot — Browser automation demo

End-to-end example: AI agent uses Playwright via `@wasmagent/tools-browser`
to navigate, extract content, and take a screenshot.

## Setup

```bash
export ANTHROPIC_API_KEY=...
bun install
bun add playwright             # peer dep — install once
bunx playwright install chromium  # download Chromium binary
bun run start
```

The script:
1. Launches headless Chromium via Playwright
2. Hands the agent 5 tools: `navigate`, `click`, `fill`, `screenshot`, `extract`
3. Asks it to visit `example.com`, extract the H1, take a screenshot
4. Saves the screenshot to `./screenshot.png`

## Headless rendering on edge / serverless

If you don't have Playwright available (e.g. running on Cloudflare
Workers), use `openCdpSession({ wsEndpoint })` instead — it talks to a
remote Chromium via the DevTools Protocol over WebSocket. No
Playwright dependency.

```ts
import { openCdpSession, buildBrowserTools } from "@wasmagent/tools-browser";

const session = await openCdpSession({
  wsEndpoint: "wss://your-chromium.example.com/devtools/browser",
});
const tools = buildBrowserTools(session);
```
