import type { ToolDefinition } from "@wasmagent/core";
import { z } from "zod";
import type { BrowserSession, NavigateResult, ScreenshotResult } from "./types.js";

export interface BrowserToolset {
  navigate: ToolDefinition<{ url: string }, NavigateResult>;
  click: ToolDefinition<{ selector: string }, { ok: true }>;
  fill: ToolDefinition<{ selector: string; value: string }, { ok: true }>;
  screenshot: ToolDefinition<{ fullPage?: boolean }, ScreenshotResult>;
  extract: ToolDefinition<{ selectors: Record<string, string> }, Record<string, string>>;
}

/**
 * Build a set of agent-callable browser tools backed by any
 * {@link BrowserSession} implementation.
 *
 * Each tool is independent — the DAG scheduler can parallelize ones
 * marked `readOnly` (extract / screenshot) while serializing the
 * mutating ones (navigate / click / fill).
 */
export function buildBrowserTools(session: BrowserSession): BrowserToolset {
  const navigate: ToolDefinition<{ url: string }, NavigateResult> = {
    name: "navigate",
    description: "Open a URL in the browser. Returns the page title and a serialized DOM snapshot.",
    inputSchema: z.object({ url: z.string().url() }),
    outputSchema: z.object({ title: z.string(), dom: z.string() }),
    readOnly: false,
    idempotent: false,
    forward: async ({ url }) => session.navigate(url),
  };

  const click: ToolDefinition<{ selector: string }, { ok: true }> = {
    name: "click",
    description: "Click an element matched by a CSS selector.",
    inputSchema: z.object({ selector: z.string() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    readOnly: false,
    idempotent: false,
    forward: async ({ selector }) => {
      await session.click(selector);
      return { ok: true };
    },
  };

  const fill: ToolDefinition<{ selector: string; value: string }, { ok: true }> = {
    name: "fill",
    description: "Type a value into an input matched by a CSS selector.",
    inputSchema: z.object({ selector: z.string(), value: z.string() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    readOnly: false,
    idempotent: false,
    forward: async ({ selector, value }) => {
      await session.fill(selector, value);
      return { ok: true };
    },
  };

  const screenshotInputSchema = z.object({
    fullPage: z.boolean().optional(),
  }) as unknown as z.ZodType<{ fullPage?: boolean }>;

  const screenshot: ToolDefinition<{ fullPage?: boolean }, ScreenshotResult> = {
    name: "screenshot",
    description: "Take a screenshot of the current page. Returns a data URL (image/png base64).",
    inputSchema: screenshotInputSchema,
    outputSchema: z.object({ dataUrl: z.string() }),
    readOnly: true,
    idempotent: true,
    forward: async ({ fullPage }) => {
      const dataUrl = await session.screenshot(fullPage !== undefined ? { fullPage } : undefined);
      return { dataUrl };
    },
  };

  const extract: ToolDefinition<{ selectors: Record<string, string> }, Record<string, string>> = {
    name: "extract",
    description:
      "Extract text content from multiple CSS selectors at once. Returns a map of label → text.",
    inputSchema: z.object({ selectors: z.record(z.string(), z.string()) }),
    outputSchema: z.record(z.string(), z.string()),
    readOnly: true,
    idempotent: true,
    forward: async ({ selectors }) => session.extract(selectors),
  };

  return { navigate, click, fill, screenshot, extract };
}
