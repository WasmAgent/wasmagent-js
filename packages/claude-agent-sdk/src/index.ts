/**
 * @agentkit-js/claude-agent-sdk — agentkit kernels as Claude Agent SDK tools.
 *
 * Anthropic's Claude Agent SDK (and the equivalent shape inside the
 * `@anthropic-ai/sdk` `tools` parameter) accepts user-defined tools as
 * a `name + description + input_schema + handler` quadruple. When the
 * model proposes `tool_use` blocks, the host calls the handler.
 *
 * That's the same shape `@agentkit-js/aisdk` adapts for Vercel AI SDK,
 * just with different field names. Rather than reinvent the kernel
 * lifecycle, this package re-exposes the two factories as Claude
 * Agent SDK tool definitions:
 *
 *   - {@link sandboxedJsClaudeTool} — one-shot JS evaluator. The model
 *     sends a snippet; the kernel runs it; the output goes back as the
 *     `tool_result`.
 *
 *   - {@link codeModeClaudeTool} — heavyweight code-mode tool. The model
 *     sends a snippet that may call `callTool(name, args)` against any
 *     registered downstream tool; only the script's final return value
 *     re-enters the model context. Token-savings parity with the
 *     `@agentkit-js/mcp-server` `execute_code` surface (see
 *     `examples/benchmarks/code-mode-tokens.mjs` — ≤14% of direct-MCP
 *     at N=30 tools).
 *
 * Both honour the unified `CapabilityManifest` (allowedHosts /
 * allowedReadPaths / allowedWritePaths / env / cpuMs /
 * memoryLimitBytes), so a security policy you wrote for the MCP server
 * works here verbatim — see
 * [`docs/strategy/security-face.md`](../../docs/strategy/security-face.md).
 *
 * Peer-dep: `@anthropic-ai/sdk` >= 0.40 (declared optional so callers
 * who use the Claude Agent SDK shape via a different transport — say,
 * via Bedrock or Vertex — can still consume the helpers). The package
 * itself does not import `@anthropic-ai/sdk` at runtime; the shape is
 * structurally typed so it remains compatible across both the
 * `@anthropic-ai/sdk` v0 line and the upcoming v1 ergonomic refactor.
 */

import {
  type CapabilityManifest,
  ProgrammaticOrchestrator,
  type ToolRegistry,
  type WasmKernel,
} from "@agentkit-js/core";

/**
 * The Claude Agent SDK tool shape, structurally typed so we are not
 * pinned to a specific `@anthropic-ai/sdk` major. The wire-level
 * surface across all current Anthropic SDKs is the four-tuple below;
 * the SDK adds method signatures around it that we don't need.
 */
export interface ClaudeAgentTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /**
   * Handler invoked by the host when the model emits a `tool_use`
   * block for this tool. The host is responsible for serializing the
   * return value into a `tool_result` block — typically by stringifying
   * objects, but a host that knows the result shape can pass it
   * through.
   */
  handler(input: unknown): Promise<unknown>;
}

// ── sandboxedJsClaudeTool ────────────────────────────────────────────────────

/** Argument shape for {@link sandboxedJsClaudeTool}. */
export interface SandboxedJsInput {
  code: string;
}

const SANDBOXED_JS_SCHEMA = {
  type: "object" as const,
  properties: {
    code: {
      type: "string",
      description:
        "JavaScript expression or block. The value of the final expression " +
        "(or the value assigned to `__finalAnswer__`) is returned.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

export interface SandboxedJsClaudeToolOptions {
  /** Tool name surfaced to the model. Default: `sandboxed_js`. */
  name?: string;
  /** Override the description. Default: a generic "run a JS snippet" line. */
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
 * One-shot sandboxed JS execution as a Claude Agent SDK tool. Mirrors
 * `sandboxedJsTool()` from `@agentkit-js/aisdk` field-for-field; only
 * the surface (Claude Agent SDK quadruple vs Vercel AI SDK
 * `tool({…})`) differs. Output is `{ output, logs }`.
 */
export function sandboxedJsClaudeTool(opts: SandboxedJsClaudeToolOptions): ClaudeAgentTool {
  return {
    name: opts.name ?? "sandboxed_js",
    description:
      opts.description ??
      "Run a JavaScript snippet inside a sandbox. Use for arithmetic, JSON " +
        "manipulation, or short scripts the user asks for. Cannot reach the host " +
        "machine — network and FS access are gated by capability.",
    input_schema: SANDBOXED_JS_SCHEMA,
    async handler(input: unknown) {
      const { code } = input as SandboxedJsInput;
      const result = await opts.kernel.run(code, opts.capabilities);
      return { output: result.output, logs: result.logs };
    },
  };
}

// ── codeModeClaudeTool ───────────────────────────────────────────────────────

/** Argument shape for {@link codeModeClaudeTool}. */
export interface CodeModeInput {
  code: string;
}

const CODE_MODE_SCHEMA = {
  type: "object" as const,
  properties: {
    code: {
      type: "string",
      description:
        "JavaScript snippet. May call `callTool(name, args)` against any " +
        "registered downstream tool. Return the final value (or assign to " +
        "`__finalAnswer__`); intermediate tool outputs are discarded.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

export interface CodeModeClaudeToolOptions extends SandboxedJsClaudeToolOptions {
  /**
   * Tools the snippet may invoke via `callTool(name, args)`. Mirrors
   * the registry passed to `createCodeModeServer` in the MCP server
   * package, and the `tools` field on `codeModeTool` in the AI SDK
   * adapter.
   */
  tools: ToolRegistry;
}

/**
 * Code-mode Claude Agent SDK tool: collapses N user-defined tools into
 * a single `execute_code` entry point on the model side. The model
 * sees this one tool; inside, the script can call any of the
 * registered tools and chain them without re-entering the model
 * context for each step. See
 * [`examples/benchmarks/code-mode-tokens.mjs`](../../examples/benchmarks/code-mode-tokens.mjs)
 * for the token-savings benchmark (≤14% of direct-tool-use at N=30).
 */
export function codeModeClaudeTool(opts: CodeModeClaudeToolOptions): ClaudeAgentTool {
  return {
    name: opts.name ?? "execute_code",
    description:
      opts.description ??
      "Run a JavaScript snippet that orchestrates multiple downstream tools " +
        "via `callTool(name, args)`. Use this when one task needs more than 2-3 " +
        "tool calls — chaining them in code is dramatically faster than " +
        "separate tool rounds and saves tokens.",
    input_schema: CODE_MODE_SCHEMA,
    async handler(input: unknown) {
      const { code } = input as CodeModeInput;
      const orchestrator = new ProgrammaticOrchestrator(
        opts.kernel,
        opts.tools,
        opts.capabilities ?? {}
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

export type { MemoryToolOptions } from "./memory.js";
// ── D3 (2026-06-13): cross-framework memory product surface ─────────────────
export { memoryClaudeTool, ObservationalMemory } from "./memory.js";
