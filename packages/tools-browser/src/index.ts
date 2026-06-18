/**
 * @wasmagent/tools-browser — browser-automation tools for agentkit-js.
 *
 * Two backends with the same {@link BrowserSession} interface:
 * - {@link openPlaywrightSession}: Playwright-backed (Chromium / Firefox /
 *   WebKit). Optional peer dep — install Playwright separately to use it.
 * - {@link openCdpSession}: Chrome DevTools Protocol over WebSocket. No
 *   external deps. Useful for edge environments and Cloudflare Browser
 *   Rendering where you have a remote Chromium endpoint.
 *
 * Build the agent-callable tool set from a session via
 * {@link buildBrowserTools}: returns 5 tools (navigate, click, fill,
 * screenshot, extract) you can pass directly into a ToolCallingAgent.
 *
 * @example
 *   const session = await openPlaywrightSession({ headless: true });
 *   const tools = buildBrowserTools(session);
 *   const agent = new ToolCallingAgent({ model, tools: Object.values(tools) });
 *   try {
 *     for await (const ev of agent.run("...")) { ... }
 *   } finally {
 *     await session.close();
 *   }
 */

// B2 (2026-06): Cloudflare Browser Run binding bridge — keeps all CDP
// message handling in `cdp.ts` while accepting the Workers binding shape.
export type { BrowserRunOpenable, BrowserRunSessionOpts } from "./browserRun.js";
export { openBrowserRunSession } from "./browserRun.js";
export type { BrowserToolset } from "./buildBrowserTools.js";
export { buildBrowserTools } from "./buildBrowserTools.js";
export type { CdpSessionOpts } from "./cdp.js";
export { openCdpSession } from "./cdp.js";
export type { PlaywrightSessionOpts } from "./playwright.js";
export { openPlaywrightSession } from "./playwright.js";
export type {
  BrowserSession,
  ExtractResult,
  NavigateResult,
  ScreenshotResult,
} from "./types.js";
