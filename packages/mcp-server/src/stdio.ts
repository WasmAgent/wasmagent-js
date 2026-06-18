#!/usr/bin/env node

/**
 * stdio.ts — newline-delimited JSON-RPC over stdin/stdout.
 *
 * Wires the existing transport-agnostic `McpAgentServer.handle()` to a
 * standard-conformant MCP stdio transport, so `agentkit-mcp-server` can
 * be exec'd by any MCP host that speaks stdio (Claude Desktop, Cursor,
 * Glama health-checks, etc.).
 *
 * ## Wire framing (per the MCP spec, all stable versions)
 *
 *   - One JSON-RPC message per line on stdin / stdout, terminated by `\n`.
 *   - Messages MUST NOT contain embedded newlines.
 *   - stdout is for responses; stderr is for log output (the host MAY
 *     ignore it and MUST NOT treat it as error signal).
 *   - Notifications (no `id` field) MUST NOT be answered.
 *
 * Spec citation: `modelcontextprotocol/specification`
 * `docs/specification/2025-11-25/basic/transports.mdx` § stdio.
 *
 * ## Default behaviour when run as `npx @wasmagent/mcp-server`
 *
 * Calling this binary with no `--config` argument starts a *minimal*
 * code-mode server with the in-process `VmKernel` and no downstream
 * tools. That is intentionally limited:
 *
 *   - It is sufficient for Glama's health check (start, answer
 *     `initialize`, answer `tools/list` with the two-tool surface).
 *   - It is not useful for production. A production deployment should
 *     either (a) write a small `server.ts` that calls `runStdio()` with
 *     a real `createCodeModeServer({ kernel, tools, capabilities })`,
 *     or (b) use one of the integration packages (e.g.
 *     `@wasmagent/aisdk`) that already wires a kernel + tool registry.
 *
 * The `--config <path>` flag (when present) loads a config module that
 * default-exports an `McpAgentServer`. Anything else is rejected to
 * keep the security surface tight — this is a long-running process
 * that hosts code execution; it should not silently load arbitrary
 * configs from the network.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ToolRegistry, VmKernel } from "@wasmagent/core";
import { createCodeModeServer } from "./codeMode.js";
import type { McpAgentServer } from "./McpAgentServer.js";

const VERSION = "0.2.0";

function logStderr(...parts: unknown[]): void {
  // Per the spec, stderr is best-effort logging; the host MAY ignore it.
  // Prefix so a host that *does* surface stderr can group our lines.
  // eslint-disable-next-line no-console
  console.error("[agentkit-mcp-server]", ...parts);
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.error(
    [
      `agentkit-mcp-server v${VERSION} — MCP stdio entry point`,
      "",
      "Usage:",
      "  agentkit-mcp-server                # default code-mode server (VmKernel, no tools)",
      "  agentkit-mcp-server --config <p>   # load a module that default-exports an McpAgentServer",
      "  agentkit-mcp-server --help         # this help",
      "  agentkit-mcp-server --version      # print version and exit",
      "",
      "The default server is suitable for Glama health-checks and basic",
      "introspection only — it has no downstream tools wired in. For a",
      "real deployment, write a small Node script that calls runStdio()",
      "with createCodeModeServer({ kernel, tools, capabilities }).",
    ].join("\n")
  );
}

/**
 * Read newline-delimited JSON-RPC from stdin, route each request through
 * `server.handle()`, write responses (and only responses — never
 * notifications) to stdout one-per-line.
 *
 * Exported so production deployments can import-and-call instead of
 * shelling out to the bin entry.
 */
export async function runStdio(server: McpAgentServer): Promise<void> {
  // Prevent any accidental console.log() from leaking into stdout — those
  // would corrupt the wire format. Route them to stderr instead.
  // (We don't override console.error because stderr IS the log channel.)
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => logStderr("[redirected console.log]", ...args);

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY, // accept either LF or CRLF; we emit LF only
  });

  rl.on("line", (line) => {
    // Process each line independently. We do NOT await here — multiple
    // requests can be in flight concurrently per the MCP spec, and the
    // host correlates by JSON-RPC `id`. handle() is responsible for
    // its own ordering invariants.
    void handleLine(server, line);
  });

  return new Promise<void>((res) => {
    rl.on("close", () => {
      logStderr("stdin closed; exiting");
      res();
    });
  });
}

async function handleLine(server: McpAgentServer, line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") return; // tolerate stray blank lines from the host

  let req: unknown;
  try {
    req = JSON.parse(trimmed);
  } catch (e) {
    // Per JSON-RPC 2.0, an unparseable line gets a -32700 with id=null. We
    // do not know the request id (parse failed before we could read it),
    // so id is `null` and the host can correlate by recency.
    writeResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${(e as Error).message}` },
    });
    return;
  }

  // Notifications: handle for side-effects, do NOT respond. Per spec a
  // notification has no `id` field at all (not just `id: null`).
  const isNotification =
    typeof req === "object" && req !== null && !("id" in (req as Record<string, unknown>));

  try {
    const result = await server.handle(req);
    if (!isNotification && result.response !== undefined) {
      writeResponse(result.response);
    }
  } catch (e) {
    logStderr("handler threw:", e);
    if (!isNotification) {
      const id =
        typeof req === "object" && req !== null && "id" in (req as Record<string, unknown>)
          ? (req as { id: unknown }).id
          : null;
      writeResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${(e as Error).message}` },
      });
    }
  }
}

function writeResponse(obj: unknown): void {
  // One JSON object per line; never embed a newline. JSON.stringify
  // already escapes `\n` inside strings, so the only newline we emit is
  // the framing one we append.
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const configIdx = args.indexOf("--config");
  let server: McpAgentServer;
  if (configIdx !== -1) {
    const configPath = args[configIdx + 1];
    if (!configPath) {
      logStderr("--config requires a path");
      return 2;
    }
    const abs = resolve(process.cwd(), configPath);
    const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
    if (!mod.default || typeof (mod.default as { handle?: unknown }).handle !== "function") {
      logStderr(`config module ${abs} must default-export an McpAgentServer (with .handle())`);
      return 2;
    }
    server = mod.default as McpAgentServer;
    logStderr(`loaded config from ${abs}`);
  } else {
    // Default: minimal code-mode server with VmKernel and no downstream tools.
    // Sufficient for `initialize` + `tools/list` + Glama health checks.
    server = createCodeModeServer({
      tools: new ToolRegistry(),
      kernel: new VmKernel(),
      serverInfo: { name: "agentkit-mcp-server", version: VERSION },
    });
    logStderr("started default code-mode server (VmKernel, 0 downstream tools)");
  }

  await runStdio(server);
  return 0;
}

// When invoked as a bin (not imported as a module), run main(). The check
// here matches the same `import.meta.url` vs argv[1] pattern the CLI uses.
const isMain =
  process.argv[1] != null &&
  new URL(import.meta.url).pathname.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").at(-1) ?? ""
  );

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      logStderr("fatal:", err);
      process.exit(1);
    }
  );
}
