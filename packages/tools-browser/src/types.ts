/**
 * Common interface for browser-automation backends.
 *
 * Both the Playwright adapter and the CDP-bridge adapter implement this
 * so the tool factories ({@link buildBrowserTools}) work against either.
 */
export interface BrowserSession {
  navigate(url: string): Promise<{ title: string; dom: string }>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  screenshot(opts?: { fullPage?: boolean }): Promise<string>; // data URL
  extract(selectors: Record<string, string>): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export interface NavigateResult {
  title: string;
  dom: string;
}

export interface ScreenshotResult {
  dataUrl: string;
}

export interface ExtractResult {
  data: Record<string, string>;
}
