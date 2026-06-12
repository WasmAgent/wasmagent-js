/**
 * @agentkit-js/openai-agents — agentkit kernels as OpenAI Agents JS tools.
 *
 * The OpenAI Agents JS SDK (`@openai/agents`) accepts a `Tool`-shaped
 * definition: `{ name, description, parameters (Zod), execute(input) }`.
 * Functionally identical to Vercel AI SDK's `tool()` shape with field
 * renaming. Rather than ask consumers to reach for a different package
 * for each upstream, we ship a thin adapter that produces the
 * structurally-typed tool object and lets them drop it into
 * `agent({ tools: […] })` directly.
 *
 *   - {@link sandboxedJsAgentTool} — one-shot JS evaluator. The agent
 *     calls it; the kernel runs the snippet; output is `{ output, logs }`.
 *
 *   - {@link codeModeAgentTool} — code-mode tool. The agent emits a
 *     snippet that may call `callTool(name, args)` against any
 *     registered downstream tool; only the script's final return value
 *     re-enters the model context.
 *
 * Both honour the unified `CapabilityManifest` (allowedHosts /
 * allowedReadPaths / allowedWritePaths / env / cpuMs /
 * memoryLimitBytes), so a security policy you wrote for the MCP server
 * works here verbatim — see
 * [`docs/strategy/security-face.md`](../../docs/strategy/security-face.md).
 *
 * Peer-dep: `@openai/agents` >= 0.1 (declared optional so unit tests
 * can run without it). The package only emits the tool's shape; it
 * does not import `@openai/agents` at runtime.
 *
 * Why a separate package from `@agentkit-js/aisdk`: although the AI
 * SDK and OpenAI Agents JS shapes are nearly identical, version
 * matrices and bundle expectations differ. Keeping them apart lets
 * upstream documentation in each ecosystem link to the package that
 * matches *their* idiom — see
 * [`docs/strategy/2026-06-competitiveness.md`](../../docs/strategy/2026-06-competitiveness.md)
 * for the upstream-first distribution play.
 */

import {
  type CapabilityManifest,
  ProgrammaticOrchestrator,
  type ToolRegistry,
  type WasmKernel,
} from "@agentkit-js/core";
import { z } from "zod";

/**
 * Structural type matching `@openai/agents` `Tool<T>` exactly. The two
 * peer-versions of `@openai/agents` we expect to see in the wild
 * (0.1.x and forthcoming 0.2.x) keep this shape; we type it
 * structurally so we are not pinned to a specific major.
 */
export interface OpenAiAgentTool<TIn, TOut> {
  name: string;
  description: string;
  parameters: z.ZodType<TIn>;
  execute(input: TIn): Promise<TOut>;
}

// ── sandboxedJsAgentTool ─────────────────────────────────────────────────────

const sandboxedJsInput = z.object({
  code: z
    .string()
    .describe(
      "JavaScript expression or block. The value of the final expression " +
        "(or the value assigned to `__finalAnswer__`) is returned.",
    ),
});

export interface SandboxedJsAgentToolOptions {
  /** Tool name surfaced to the model. Default: `sandboxed_js`. */
  name?: string;
  /** Override the tool description shown to the model. */
  description?: string;
  /**
   * Kernel that runs the snippet. Use `QuickJSKernel` for edge-safe
   * execution on Workers / Vercel Edge; `JsKernel` for Node-only quick
   * prototypes; `RemoteSandboxKernel` (E2B / Cloudflare Sandbox) for
   * full process isolation.
   */
  kernel: WasmKernel;
  /** Optional capability allow-list; defaults to deny-all. */
  capabilities?: Partial<CapabilityManifest>;
}

/**
 * One-shot sandboxed JS execution as an OpenAI Agents tool.
 * Mirrors `sandboxedJsTool()` from `@agentkit-js/aisdk` field-for-field;
 * only the surface (`OpenAiAgentTool` vs Vercel AI SDK's `tool()`)
 * differs.
 */
export function sandboxedJsAgentTool(
  opts: SandboxedJsAgentToolOptions,
): OpenAiAgentTool<{ code: string }, { output: unknown; logs: string[] }> {
  return {
    name: opts.name ?? "sandboxed_js",
    description:
      opts.description ??
      "Run a JavaScript snippet inside a sandbox. Use for arithmetic, JSON " +
        "manipulation, or short scripts the user asks for. Cannot reach the host " +
        "machine — network and FS access are gated by capability.",
    parameters: sandboxedJsInput,
    async execute({ code }) {
      const result = await opts.kernel.run(code, opts.capabilities);
      return { output: result.output, logs: result.logs };
    },
  };
}

// ── codeModeAgentTool ────────────────────────────────────────────────────────

const codeModeInput = z.object({
  code: z
    .string()
    .describe(
      "JavaScript snippet. May call `callTool(name, args)` against any " +
        "registered downstream tool. Return the final value (or assign to " +
        "`__finalAnswer__`); intermediate tool outputs are discarded.",
    ),
});

export interface CodeModeAgentToolOptions extends SandboxedJsAgentToolOptions {
  /**
   * Tools the snippet may invoke via `callTool(name, args)`. Mirrors
   * the registry passed to `createCodeModeServer` in the MCP server
   * package and the `tools` field on the AI SDK / Claude adapters.
   */
  tools: ToolRegistry;
}

/**
 * Code-mode OpenAI Agents tool: collapses N user-defined tools into a
 * single `execute_code` entry point on the model side. The model sees
 * this one tool; inside, the script can call any of the registered
 * tools and chain them without re-entering the model context for each
 * step. See
 * [`examples/benchmarks/code-mode-tokens.mjs`](../../examples/benchmarks/code-mode-tokens.mjs)
 * for the token-savings benchmark (≤14% of direct-tool-use at N=30).
 */
export function codeModeAgentTool(
  opts: CodeModeAgentToolOptions,
): OpenAiAgentTool<{ code: string }, { output: string; toolCallCount: number }> {
  return {
    name: opts.name ?? "execute_code",
    description:
      opts.description ??
      "Run a JavaScript snippet that orchestrates multiple downstream tools " +
        "via `callTool(name, args)`. Use this when one task needs more than 2-3 " +
        "tool calls — chaining them in code is dramatically faster than " +
        "separate tool rounds and saves tokens.",
    parameters: codeModeInput,
    async execute({ code }) {
      const orchestrator = new ProgrammaticOrchestrator(
        opts.kernel,
        opts.tools,
        opts.capabilities ?? {},
      );
      const result = await orchestrator.run(code);
      return {
        output:
          typeof result.finalOutput === "string"
            ? result.finalOutput
            : JSON.stringify(result.finalOutput),
        toolCallCount: result.toolCallCount,
      };
    },
  };
}
