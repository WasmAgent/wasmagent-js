/**
 * @agentkit-js/aisdk — make agentkit kernels available as Vercel AI SDK tools.
 *
 * The Vercel AI SDK (`ai` package) ships great DX for streaming, tool calling,
 * and agent loops — but its default tool execution path runs the JS function
 * `execute` straight in your runtime. That's fine for typed business
 * functions. It is NOT fine when the LLM is generating the code: an agent
 * that emits `eval(userPrompt)` on a Worker has no isolation between the
 * model's output and your service.
 *
 * This package gives the AI SDK two reusable tool factories that delegate to
 * agentkit's `Kernel` family:
 *
 *   - {@link sandboxedJsTool} — one-shot JS evaluator. Drop-in for
 *     "let the model run a snippet to do math / parse JSON / try things"
 *     workflows. Output is whatever the snippet returns.
 *
 *   - {@link codeModeTool} — the heavyweight version. Same idea as
 *     `@agentkit-js/mcp-server`'s code-mode server, but as an AI SDK tool:
 *     the LLM script can call any tool you registered into the supplied
 *     `ToolRegistry` via `callTool(name, args)`, and only the script's final
 *     return value re-enters the model context.
 *
 * Both honour the unified `CapabilityManifest` (allowedHosts /
 * allowedReadPaths / allowedWritePaths / env / cpuMs / memoryLimitBytes), so
 * a security policy you wrote for the MCP server works here verbatim.
 *
 * Peer-deps: `ai` ^4 || ^5 || ^6 and `zod` ^3 || ^4. The package only uses
 * the `tool()` helper, which is stable across these majors — but we declare
 * peers to make the contract explicit.
 */

import {
  type CapabilityManifest,
  ProgrammaticOrchestrator,
  type ToolRegistry,
  type WasmKernel,
} from "@agentkit-js/core";
import { z } from "zod";

// We intentionally type the AI SDK's `tool()` helper structurally instead of
// importing it. Importing `ai` here would force the consumer's bundler to
// pull the whole AI SDK runtime even when they only want one of these
// factories — and would lock us to a single major. The structural type below
// matches `tool()`'s public contract for `tool({description, parameters, execute})`.
export interface AiSdkToolDefinition<TIn, TOut> {
  description: string;
  parameters: z.ZodType<TIn>;
  execute(input: TIn): Promise<TOut>;
}

// ── sandboxedJsTool ──────────────────────────────────────────────────────────

const sandboxedJsInput = z.object({
  code: z
    .string()
    .describe(
      "JavaScript expression or block. The value of the final expression " +
        "(or the value assigned to `__finalAnswer__`) is returned."
    ),
});

export interface SandboxedJsToolOptions {
  /**
   * Kernel that runs the snippet. Use `QuickJSKernel` for edge-safe execution
   * on Workers / Vercel Edge; `JsKernel` for Node-only quick prototypes;
   * `RemoteSandboxKernel` (E2B / Cloudflare Sandbox) for full process isolation.
   */
  kernel: WasmKernel;
  /** Optional: restrict what the snippet can do. See `CapabilityManifest`. */
  capabilities?: Partial<CapabilityManifest>;
  /**
   * Override the tool description shown to the model. The default is fine for
   * most cases; override when the model needs a domain-specific hint
   * ("Use this to manipulate the catalogue JSON").
   */
  description?: string;
}

/**
 * One-shot sandboxed JS execution as an AI SDK tool. The model emits a
 * snippet; the kernel runs it; the returned object is `{ output, logs }`.
 */
export function sandboxedJsTool(
  opts: SandboxedJsToolOptions
): AiSdkToolDefinition<{ code: string }, { output: unknown; logs: string[] }> {
  const description =
    opts.description ??
    "Run a JavaScript snippet inside a sandbox. Use for arithmetic, JSON " +
      "manipulation, or short scripts the user asks for. Cannot reach the host " +
      "machine — network and FS access are gated by capability.";
  return {
    description,
    parameters: sandboxedJsInput,
    async execute({ code }) {
      const result = await opts.kernel.run(code, opts.capabilities);
      return { output: result.output, logs: result.logs };
    },
  };
}

// ── codeModeTool ─────────────────────────────────────────────────────────────

const codeModeInput = z.object({
  code: z
    .string()
    .describe(
      "JavaScript snippet. May call `callTool(name, args)` against any " +
        "registered downstream tool. Return the final value (or assign to " +
        "`__finalAnswer__`); intermediate tool outputs are discarded."
    ),
});

export interface CodeModeToolOptions extends SandboxedJsToolOptions {
  /**
   * Tools the snippet may invoke via `callTool(name, args)`. Mirrors the
   * registry passed to `createCodeModeServer` in the MCP server package.
   */
  tools: ToolRegistry;
}

/**
 * Code-mode AI SDK tool: collapses N user-defined tools into a single
 * `execute_code` entry point on the model side. The model sees this one
 * tool; inside, the script can call any of the registered tools and chain
 * them without re-entering the model context for each step.
 */
export function codeModeTool(
  opts: CodeModeToolOptions
): AiSdkToolDefinition<{ code: string }, { output: string; toolCallCount: number }> {
  const description =
    opts.description ??
    "Run a JavaScript snippet that orchestrates multiple downstream tools " +
      "via `callTool(name, args)`. Use this when one task needs more than 2-3 " +
      "tool calls — chaining them in code is dramatically faster than " +
      "separate tool rounds and saves tokens.";
  return {
    description,
    parameters: codeModeInput,
    async execute({ code }) {
      const orchestrator = new ProgrammaticOrchestrator(
        opts.kernel,
        opts.tools,
        opts.capabilities ?? {}
      );
      const result = await orchestrator.run(code);
      return { output: result.finalOutput, toolCallCount: result.toolCallCount };
    },
  };
}

// ── Cloudflare codemode adapter (Direction 1) ───────────────────────────────
// Re-exported so consumers can import the public surface from the package
// root. The implementation lives in `./codemodeExecutor` and is currently
// at part-1-of-3 (types + signature only — see that file's docblock).
export {
  agentkitCodemodeExecutor,
  type AgentkitCodemodeExecutorOptions,
  type CodemodeExecuteResult,
  type CodemodeExecutor,
  type CodemodeProvidersOrFns,
  type CodemodeResolvedProvider,
} from "./codemodeExecutor.js";
