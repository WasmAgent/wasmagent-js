import type { BrowserSession } from "./types.js";

export interface PlaywrightSessionOpts {
  /** Run headless. Default true. */
  headless?: boolean;
  /** Default navigation timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Override the launcher; primarily useful for tests. */
  launcher?: "chromium" | "firefox" | "webkit";
}

interface PlaywrightModule {
  chromium: { launch: (opts?: { headless?: boolean }) => Promise<unknown> };
  firefox: { launch: (opts?: { headless?: boolean }) => Promise<unknown> };
  webkit: { launch: (opts?: { headless?: boolean }) => Promise<unknown> };
}

/**
 * Browser session backed by Playwright.
 *
 * Playwright is an *optional* peer dependency. This module imports it
 * lazily so consumers without browser-automation needs don't pay the
 * Chromium download / install cost.
 *
 * @example
 *   const session = await openPlaywrightSession({ headless: true });
 *   try {
 *     const tools = buildBrowserTools(session);
 *     // ... pass tools to ToolCallingAgent ...
 *   } finally {
 *     await session.close();
 *   }
 */
export async function openPlaywrightSession(
  opts: PlaywrightSessionOpts = {}
): Promise<BrowserSession> {
  const headless = opts.headless ?? true;
  const launcher = opts.launcher ?? "chromium";
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let pw: PlaywrightModule;
  try {
    pw = (await import("playwright")) as unknown as PlaywrightModule;
  } catch (e) {
    throw new Error(
      `@agentkit-js/tools-browser: 'playwright' is not installed. Install with: bun add playwright (or npm install playwright). Original error: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  const browser = (await pw[launcher].launch({ headless })) as {
    newContext: () => Promise<unknown>;
    close: () => Promise<void>;
  };
  const ctx = (await browser.newContext()) as {
    newPage: () => Promise<unknown>;
  };
  const page = (await ctx.newPage()) as {
    setDefaultTimeout: (n: number) => void;
    goto: (u: string) => Promise<unknown>;
    title: () => Promise<string>;
    content: () => Promise<string>;
    click: (s: string) => Promise<void>;
    fill: (s: string, v: string) => Promise<void>;
    screenshot: (opts?: { fullPage?: boolean }) => Promise<Uint8Array>;
    $$eval: (selector: string, fn: (els: Element[]) => string) => Promise<string>;
  };
  page.setDefaultTimeout(timeoutMs);

  return {
    async navigate(url: string) {
      await page.goto(url);
      const [title, dom] = await Promise.all([page.title(), page.content()]);
      return { title, dom };
    },
    async click(selector: string) {
      await page.click(selector);
    },
    async fill(selector: string, value: string) {
      await page.fill(selector, value);
    },
    async screenshot(opts?: { fullPage?: boolean }) {
      const buf = await page.screenshot(
        opts !== undefined ? { fullPage: opts.fullPage ?? false } : undefined
      );
      const b64 = Buffer.from(buf).toString("base64");
      return `data:image/png;base64,${b64}`;
    },
    async extract(selectors: Record<string, string>) {
      const out: Record<string, string> = {};
      const errors: string[] = [];
      for (const [label, selector] of Object.entries(selectors)) {
        try {
          out[label] = await page.$$eval(selector, (els) =>
            els
              .map((e) => (e as HTMLElement).innerText ?? e.textContent ?? "")
              .join("\n")
              .trim()
          );
        } catch (e) {
          // Surface evaluation failures as part of the result instead of
          // silently returning "" — the agent would otherwise infer the
          // page has no matches when actually the evaluation crashed.
          const msg = e instanceof Error ? e.message : String(e);
          out[label] = "";
          errors.push(`${label} (${selector}): ${msg}`);
        }
      }
      if (errors.length > 0) {
        // Throw with a structured message — the agent's error path will
        // pick this up and can retry / adjust selectors.
        throw new Error(
          `playwright extract failed for ${errors.length} selector(s): ${errors.join("; ")}`
        );
      }
      return out;
    },
    async close() {
      await browser.close();
    },
  };
}
