import { openCdpSession } from "./cdp.js";
import type { BrowserSession } from "./types.js";

/**
 * B2 (2026-06): Cloudflare Browser Run / Browser Rendering integration.
 *
 * Cloudflare's 2026 Agents Week introduced Browser Run — a managed
 * Chromium with Live View, HITL, and CDP exposed directly to a Worker
 * via a `BROWSER` binding. The contract is documented at
 * developers.cloudflare.com/browser-rendering. We do NOT depend on
 * `@cloudflare/puppeteer` here because:
 *
 *   1. It's a Worker-only build with non-trivial bundle weight.
 *   2. The bindings API is still moving — pinning would freeze us
 *      to the version that shipped the day we built this file.
 *   3. The only thing we need from Browser Run is a CDP WebSocket
 *      endpoint, which the binding exposes via either `connect()`
 *      (older "Browser Rendering" surface) or a documented
 *      `cdpUrl()` resolver (newer Browser Run surface).
 *
 * So we accept a structural type that captures only the cap we need:
 * `connect(): Promise<{ wsEndpoint(): string; close(): Promise<void> }>`
 * which matches both `@cloudflare/puppeteer.launch(env.BROWSER)` (the
 * supported public API today) and any future binding that exposes a
 * raw CDP WebSocket.
 *
 * The function delegates to {@link openCdpSession} once a wsEndpoint
 * is in hand — keeping all CDP message handling in one place.
 */

export interface BrowserRunOpenable {
  /**
   * Opens a Browser Run session and returns an object exposing the
   * underlying CDP WebSocket endpoint string. Mirrors the shape of
   * `puppeteer.launch(env.BROWSER)` in `@cloudflare/puppeteer`.
   *
   * The implementation owns process lifetime; we call `close()` on
   * teardown.
   */
  connect(): Promise<{
    wsEndpoint: string | (() => string);
    close?: () => Promise<void>;
  }>;
}

export interface BrowserRunSessionOpts {
  /**
   * The Browser Run binding from your `wrangler.toml`. Pass
   * `await puppeteer.launch(env.BROWSER)` here, or any other object
   * that satisfies {@link BrowserRunOpenable}.
   */
  binding: BrowserRunOpenable;
  /** Default navigation timeout. */
  timeoutMs?: number;
}

/**
 * Open a {@link BrowserSession} backed by Cloudflare Browser Run.
 *
 * Usage in a Workers fetch handler:
 *
 * ```ts
 * import puppeteer from "@cloudflare/puppeteer";
 * import { openBrowserRunSession } from "@agentkit-js/tools-browser";
 *
 * export default {
 *   async fetch(req: Request, env: Env) {
 *     const session = await openBrowserRunSession({
 *       binding: { connect: () => puppeteer.launch(env.BROWSER) },
 *       timeoutMs: 30_000,
 *     });
 *     try {
 *       await session.navigate("https://example.com");
 *       const r = await session.extract({ title: "title" });
 *       return Response.json(r);
 *     } finally {
 *       await session.close();
 *     }
 *   },
 * };
 * ```
 *
 * In a non-Workers environment, `openCdpSession` against a vanilla
 * Chromium is still the right entry point — this function only
 * exists to bridge the Workers binding shape.
 */
export async function openBrowserRunSession(opts: BrowserRunSessionOpts): Promise<BrowserSession> {
  const handle = await opts.binding.connect();
  const wsEndpoint =
    typeof handle.wsEndpoint === "function" ? handle.wsEndpoint() : handle.wsEndpoint;
  const cdp = await openCdpSession({
    wsEndpoint,
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
  });
  // Wrap close so the BR binding's resource is released when the
  // BrowserSession is closed by the caller — otherwise the CF account
  // is billed for an orphaned headless tab.
  const originalClose = cdp.close.bind(cdp);
  return Object.assign(cdp, {
    async close() {
      try {
        await originalClose();
      } finally {
        if (handle.close) await handle.close().catch(() => undefined);
      }
    },
  });
}
