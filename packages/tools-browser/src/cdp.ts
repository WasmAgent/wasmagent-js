import type { BrowserSession } from "./types.js";

export interface CdpSessionOpts {
  /** WebSocket endpoint of a running Chromium with --remote-debugging-port=. */
  wsEndpoint: string;
  /** Default navigation timeout. */
  timeoutMs?: number;
}

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Minimal Chrome DevTools Protocol client backed by a single WebSocket.
 *
 * Useful when the consumer is already running inside or alongside a
 * Chromium instance (e.g. Cloudflare Browser Rendering, or a Docker
 * container with Chrome exposed) and doesn't want to bundle Playwright.
 */
class CdpClient {
  readonly #ws: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(wsEndpoint: string) {
    this.#ws = new WebSocket(wsEndpoint);
    this.#ws.addEventListener("message", (ev) => {
      const data = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof data.id !== "number") return;
      const handler = this.#pending.get(data.id);
      if (!handler) return;
      this.#pending.delete(data.id);
      if (data.error) handler.reject(new Error(data.error.message));
      else handler.resolve(data.result);
    });
  }

  async ready(): Promise<void> {
    if (this.#ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.#ws.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = () => {
        this.#ws.removeEventListener("open", onOpen);
        reject(new Error("CDP WebSocket failed to open"));
      };
      this.#ws.addEventListener("open", onOpen, { once: true });
      this.#ws.addEventListener("error", onErr, { once: true });
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const req: CdpRequest = params ? { id, method, params } : { id, method };
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify(req));
    });
  }

  close(): void {
    this.#ws.close();
  }
}

/**
 * Open a browser session backed by a remote Chromium DevTools endpoint.
 *
 * Note: this is a minimal CDP wrapper covering the same ops as the
 * Playwright session (navigate / click / fill / screenshot / extract).
 * For complex scenarios prefer Playwright; for edge environments
 * (Workers, serverless) where a Chromium is reachable but Playwright
 * isn't installed, this is the lighter path.
 */
export async function openCdpSession(opts: CdpSessionOpts): Promise<BrowserSession> {
  const cdp = new CdpClient(opts.wsEndpoint);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");

  return {
    async navigate(url: string) {
      await cdp.send("Page.navigate", { url });
      // Wait for load event by polling document.readyState
      const start = Date.now();
      const timeoutMs = opts.timeoutMs ?? 30_000;
      while (Date.now() - start < timeoutMs) {
        const r = (await cdp.send("Runtime.evaluate", {
          expression: "document.readyState",
        })) as { result: { value: string } };
        if (r.result.value === "complete") break;
        await new Promise((res) => setTimeout(res, 100));
      }
      const titleR = (await cdp.send("Runtime.evaluate", { expression: "document.title" })) as {
        result: { value: string };
      };
      const domR = (await cdp.send("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
      })) as { result: { value: string } };
      return { title: titleR.result.value, dom: domR.result.value };
    },
    async click(selector: string) {
      await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
      });
    },
    async fill(selector: string, value: string) {
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`;
      await cdp.send("Runtime.evaluate", { expression: expr });
    },
    async screenshot(screenshotOpts?: { fullPage?: boolean }) {
      const r = (await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: screenshotOpts?.fullPage ?? false,
      })) as { data: string };
      return `data:image/png;base64,${r.data}`;
    },
    async extract(selectors: Record<string, string>) {
      const out: Record<string, string> = {};
      for (const [label, selector] of Object.entries(selectors)) {
        const expr = `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .map(e => e.innerText ?? e.textContent ?? '').join('\\n').trim()`;
        const r = (await cdp.send("Runtime.evaluate", { expression: expr })) as {
          result: { value?: string };
        };
        out[label] = r.result.value ?? "";
      }
      return out;
    },
    async close() {
      cdp.close();
    },
  };
}
