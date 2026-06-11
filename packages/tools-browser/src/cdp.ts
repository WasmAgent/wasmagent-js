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
  readonly #defaultTimeoutMs: number;
  #nextId = 1;
  #closed = false;
  readonly #pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(wsEndpoint: string, defaultTimeoutMs = 30_000) {
    this.#ws = new WebSocket(wsEndpoint);
    this.#defaultTimeoutMs = defaultTimeoutMs;

    this.#ws.addEventListener("message", (ev) => {
      let data: { id?: number; result?: unknown; error?: { message: string } };
      try {
        data = JSON.parse(String(ev.data));
      } catch (err) {
        // Don't throw inside an event listener — that would crash the WS
        // pipeline and leak every pending RPC indefinitely.
        console.warn("[CdpClient] dropping malformed message", {
          sample: String(ev.data).slice(0, 200),
          error: err,
        });
        return;
      }
      if (typeof data.id !== "number") return;
      const handler = this.#pending.get(data.id);
      if (!handler) return;
      this.#pending.delete(data.id);
      clearTimeout(handler.timeoutId);
      if (data.error) handler.reject(new Error(data.error.message));
      else handler.resolve(data.result);
    });

    // When the underlying WS dies, every in-flight RPC must be rejected
    // — otherwise callers hang forever waiting for a response that will
    // never arrive.
    const rejectAllPending = (reason: string) => {
      this.#closed = true;
      for (const { reject, timeoutId } of this.#pending.values()) {
        clearTimeout(timeoutId);
        reject(new Error(`CdpClient: ${reason}`));
      }
      this.#pending.clear();
    };
    this.#ws.addEventListener("close", () => rejectAllPending("WebSocket closed"));
    this.#ws.addEventListener("error", () => rejectAllPending("WebSocket error"));
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
    if (this.#closed) {
      return Promise.reject(new Error("CdpClient: cannot send on closed connection"));
    }
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const req: CdpRequest = params ? { id, method, params } : { id, method };
      // Per-request timeout — without this, a stuck remote browser hangs
      // the call forever.
      const timeoutId = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`CdpClient: ${method} timed out after ${this.#defaultTimeoutMs}ms`));
        }
      }, this.#defaultTimeoutMs);
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutId,
      });
      try {
        this.#ws.send(JSON.stringify(req));
      } catch (e) {
        clearTimeout(timeoutId);
        this.#pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timeoutId } of this.#pending.values()) {
      clearTimeout(timeoutId);
      reject(new Error("CdpClient: connection closed by user"));
    }
    this.#pending.clear();
    try {
      this.#ws.close();
    } catch {
      // already closed — safe to ignore
    }
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
  const cdp = new CdpClient(opts.wsEndpoint, opts.timeoutMs);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");

  // Helper: run a JS expression in the page and surface CDP exceptions
  // explicitly. Without this, `r.result.value` is silently `undefined`
  // when the evaluation throws (CDP populates `exceptionDetails` instead).
  const evaluate = async <T = string>(expression: string): Promise<T> => {
    const r = (await cdp.send("Runtime.evaluate", { expression })) as {
      result: { value?: T };
      exceptionDetails?: { text: string };
    };
    if (r.exceptionDetails) {
      throw new Error(`CDP eval threw: ${r.exceptionDetails.text}`);
    }
    return r.result.value as T;
  };

  return {
    async navigate(url: string) {
      await cdp.send("Page.navigate", { url });
      // Wait for load event by polling document.readyState
      const start = Date.now();
      const timeoutMs = opts.timeoutMs ?? 30_000;
      while (Date.now() - start < timeoutMs) {
        const state = await evaluate<string>("document.readyState");
        if (state === "complete") break;
        await new Promise((res) => setTimeout(res, 100));
      }
      const title = await evaluate<string>("document.title");
      const dom = await evaluate<string>("document.documentElement.outerHTML");
      return { title, dom };
    },
    async click(selector: string) {
      await evaluate<void>(`document.querySelector(${JSON.stringify(selector)})?.click()`);
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
      await evaluate<void>(expr);
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
        // Let evaluate() throw on CDP exceptions — extract should not
        // silently return "" when the page evaluation crashes; the agent
        // would otherwise see "no matches" and infer a wrong fact.
        out[label] = (await evaluate<string>(expr)) ?? "";
      }
      return out;
    },
    async close() {
      cdp.close();
    },
  };
}
