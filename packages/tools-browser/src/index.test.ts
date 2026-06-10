import { describe, expect, it, vi } from "vitest";
import { type BrowserSession, buildBrowserTools } from "./index.js";

function fakeSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    navigate: vi.fn(async (url: string) => ({
      title: `Title for ${url}`,
      dom: `<html><body>${url}</body></html>`,
    })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    screenshot: vi.fn(async () => "data:image/png;base64,FAKE"),
    extract: vi.fn(async (sels: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const k of Object.keys(sels)) out[k] = `text-of-${k}`;
      return out;
    }),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("buildBrowserTools — toolset shape", () => {
  it("exposes 5 tools", () => {
    const tools = buildBrowserTools(fakeSession());
    expect(Object.keys(tools).sort()).toEqual([
      "click",
      "extract",
      "fill",
      "navigate",
      "screenshot",
    ]);
  });

  it("readOnly + idempotent flags are correct for parallel scheduling", () => {
    const tools = buildBrowserTools(fakeSession());
    // navigate / click / fill mutate page state
    expect(tools.navigate.readOnly).toBe(false);
    expect(tools.click.readOnly).toBe(false);
    expect(tools.fill.readOnly).toBe(false);
    // screenshot / extract are pure reads — DAG can parallelize them
    expect(tools.screenshot.readOnly).toBe(true);
    expect(tools.screenshot.idempotent).toBe(true);
    expect(tools.extract.readOnly).toBe(true);
    expect(tools.extract.idempotent).toBe(true);
  });
});

describe("navigate tool", () => {
  it("calls session.navigate with the URL", async () => {
    const session = fakeSession();
    const { navigate } = buildBrowserTools(session);
    const out = await navigate.forward({ url: "https://example.com" }, {} as never);
    expect(session.navigate).toHaveBeenCalledWith("https://example.com");
    expect(out.title).toBe("Title for https://example.com");
    expect(out.dom).toContain("example.com");
  });

  it("rejects invalid URLs at the schema layer", () => {
    const tools = buildBrowserTools(fakeSession());
    const result = tools.navigate.inputSchema.safeParse({ url: "not a url" });
    expect(result.success).toBe(false);
  });
});

describe("click tool", () => {
  it("forwards the selector to the session", async () => {
    const session = fakeSession();
    const { click } = buildBrowserTools(session);
    const out = await click.forward({ selector: "#submit" }, {} as never);
    expect(session.click).toHaveBeenCalledWith("#submit");
    expect(out).toEqual({ ok: true });
  });
});

describe("fill tool", () => {
  it("forwards selector + value to the session", async () => {
    const session = fakeSession();
    const { fill } = buildBrowserTools(session);
    await fill.forward({ selector: "#email", value: "a@b.com" }, {} as never);
    expect(session.fill).toHaveBeenCalledWith("#email", "a@b.com");
  });
});

describe("screenshot tool", () => {
  it("returns a data URL", async () => {
    const session = fakeSession();
    const { screenshot } = buildBrowserTools(session);
    const out = await screenshot.forward({}, {} as never);
    expect(out.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("passes fullPage option through", async () => {
    const session = fakeSession();
    const { screenshot } = buildBrowserTools(session);
    await screenshot.forward({ fullPage: true }, {} as never);
    expect(session.screenshot).toHaveBeenCalledWith({ fullPage: true });
  });
});

describe("extract tool", () => {
  it("returns a map of label → text", async () => {
    const session = fakeSession();
    const { extract } = buildBrowserTools(session);
    const out = await extract.forward({ selectors: { title: "h1", desc: ".desc" } }, {} as never);
    expect(out).toEqual({ title: "text-of-title", desc: "text-of-desc" });
  });
});

describe("generic-foundation principle", () => {
  it("no tool name references a specific product", () => {
    const tools = buildBrowserTools(fakeSession());
    const names = Object.values(tools).map((t) => t.name);
    for (const name of names) {
      expect(name).not.toMatch(/bscode|bolt|lovable/i);
    }
  });
});
