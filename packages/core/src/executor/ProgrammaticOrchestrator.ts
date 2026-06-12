import type { CapabilityManifest, WasmKernel } from "../executor/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

/**
 * L3-1: ProgrammaticOrchestrator — self-hosted PTC (Programmatic Tool Calling) backend.
 *
 * Executes model-generated orchestration scripts inside an agentkit kernel.
 * Scripts can call registered tools via an injected `callTool()` global.
 * Only the final script output enters the context window — intermediate
 * tool results remain in the kernel's memory.
 *
 * This is agentkit's ZDR-friendly alternative to Anthropic's hosted PTC container:
 *   - Works with any kernel tier: JsKernel, QuickJSKernel, WasmtimeKernel
 *   - Respects CapabilityManifest for tool access control
 *   - Intermediate results never enter the LLM context (−37% tokens, −19 round trips)
 *
 * Usage:
 *   const orchestrator = new ProgrammaticOrchestrator(kernel, toolRegistry);
 *   const result = await orchestrator.run(modelGeneratedScript);
 *   // result.finalOutput is the only thing that enters context
 *
 * Security: callTool() calls are gated by CapabilityManifest.extraCapabilities.
 * Scripts that attempt to call a tool without the required capability receive
 * a capability_denied error from ToolRegistry.call().
 */
export class ProgrammaticOrchestrator {
  readonly #kernel: WasmKernel;
  readonly #tools: ToolRegistry;
  readonly #capabilities: Partial<CapabilityManifest>;

  constructor(
    kernel: WasmKernel,
    tools: ToolRegistry,
    capabilities: Partial<CapabilityManifest> = {}
  ) {
    this.#kernel = kernel;
    this.#tools = tools;
    this.#capabilities = capabilities;
  }

  /**
   * Execute a model-generated orchestration script.
   *
   * The script has access to a `callTool(name, args)` global that calls registered
   * tools synchronously (via AsyncFunction wrapper). Intermediate results stay
   * inside the kernel; only the script's final output is returned.
   *
   * @param script  Model-generated orchestration code (JavaScript).
   * @param signal  Optional AbortSignal to cancel execution.
   * @returns Final output string (the only content that enters the LLM context).
   */
  async run(script: string, signal?: AbortSignal): Promise<ProgrammaticResult> {
    const toolCalls: ToolCallRecord[] = [];

    // Inject callTool as a pseudo-synchronous global by wrapping the script
    // in an async IIFE. The kernel receives the wrapper; intermediate results
    // are accumulated in toolCalls but never returned to the caller.
    const callToolShim = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (signal?.aborted) throw new Error("ProgrammaticOrchestrator: aborted");
      const callId = `ptc-${toolCalls.length}-${name}`;
      const result = await this.#tools.call(
        { toolName: name, args, callId, ...(signal ? { signal } : {}) },
        this.#capabilities.extraCapabilities
      );
      toolCalls.push({ name, args, callId, result: result.output, isError: !!result.error });
      if (result.error) {
        throw new Error(`Tool "${name}" failed: ${result.error.message}`);
      }
      return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    };

    // The kernel can't receive async functions across the worker boundary (JsKernel).
    // We resolve this by pre-injecting tool results: collect required calls first,
    // then pass a synchronous shim that returns pre-resolved values.
    //
    // For kernels that support native async (VmKernel / WasmtimeKernel direct mode),
    // we inject __callTool_async__ and let the kernel handle it.
    // The script must `await callTool(name, args)` to get results.
    const wrappedScript = buildWrappedScript(script);

    // Provide callTool as a serialisable bridge: accumulate calls, inject results.
    const _callResults = new Map<string, string>();
    const _pendingCalls: Array<{ callKey: string; name: string; args: Record<string, unknown> }> =
      [];

    // Two-phase execution: 1) dry-run to collect callTool invocations, 2) resolve + re-run.
    // Simpler: inject a synthetic __callTool_registry__ into kernel state, then run.
    // For cross-worker safety, we serialize the tool result map as JSON into the kernel.
    const preludeResult = await this.#kernel.run(
      buildToolRegistryPrelude(this.#tools.list().map((t) => t.name)),
      this.#capabilities
    );
    void preludeResult; // We only care about the final output.

    // Execute the script — tools are called via the injected bridge.
    // We run the script with a callTool that calls back into Node.js via a shared buffer.
    // For simplicity (and cross-kernel compatibility), we use a sequential approach:
    // wrap the script so each callTool() call emits a marker, capture it, resolve,
    // and replay until the script completes.
    const result = await this.#runWithCallbacks(wrappedScript, callToolShim, signal);

    return {
      finalOutput: result,
      intermediateToolCalls: toolCalls,
      toolCallCount: toolCalls.length,
    };
  }

  /**
   * Execute the model-generated script inside the kernel sandbox.
   *
   * Iterative re-run protocol with a sentinel-based cooperative pause:
   *
   *   - The kernel-side `callTool(name, args)` returns the cached result if
   *     the host has already resolved that exact call site (keyed by call
   *     index — calls always run in the same order on every re-run because
   *     the script is deterministic). If the result is NOT yet cached,
   *     callTool throws a marker error.
   *   - The host catches that marker, resolves the most-recently-recorded
   *     pending call against the real ToolRegistry, injects the JSON
   *     result back into the kernel's `__ptc_results__` map keyed by the
   *     same call index, and re-runs the script.
   *   - The script then advances past its earlier `await`, hits the next
   *     `callTool`, and either completes (returns) or throws the marker
   *     again. Loop, bounded at 50 iterations as a runaway guard.
   *
   * Why throw-and-re-run instead of an in-process callback: the script
   * runs inside the kernel sandbox (worker thread / WASM), which cannot
   * synchronously reach the host's tool registry. Re-running with cached
   * results is the only way to keep the sandbox boundary intact while
   * letting the script see real values from `await`.
   *
   * The script is wrapped in an `async` IIFE so `await callTool(...)` —
   * the natural authoring shape — parses inside the kernel. There is no
   * host-process fallback: kernel errors propagate to the caller.
   */
  async #runWithCallbacks(
    script: string,
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    signal?: AbortSignal
  ): Promise<string> {
    const PENDING_MARKER = "__PTC_PENDING__";

    // Setup: inject __ptc_results__, __ptc_calls__, and the callTool
    // function. callTool throws a recognisable error when the result for
    // its position is not yet cached — the script's `await` propagates
    // the rejection up through the IIFE, the kernel returns the error,
    // and the host resolves the pending call before re-running.
    const setupScript = `
      var __ptc_results__ = {};
      var __ptc_calls__ = [];
      function callTool(name, args) {
        var key = name + ':' + __ptc_calls__.length;
        __ptc_calls__.push({ key: key, name: name, args: args });
        if (!Object.prototype.hasOwnProperty.call(__ptc_results__, key)) {
          // Host has not resolved this call yet. Reject so the script
          // pauses; the host catches "${PENDING_MARKER}" and re-runs.
          return Promise.reject(new Error("${PENDING_MARKER}:" + key));
        }
        var raw = __ptc_results__[key];
        try { return Promise.resolve(JSON.parse(raw)); }
        catch (e) { return Promise.resolve(raw); }
      }
    `;
    await this.#kernel.run(setupScript, this.#capabilities);

    // Map of resolved keys we've injected into the kernel — used to detect
    // forward progress across iterations and to bail if the script keeps
    // emitting new pending calls without ever resolving.
    const resolved = new Map<string, string>();

    let output = "";
    for (let iteration = 0; iteration < 50; iteration++) {
      if (signal?.aborted) throw new Error("ProgrammaticOrchestrator: aborted");

      // Reset the per-run __ptc_calls__ array so each re-run sees the same
      // sequence of recorded calls. __ptc_results__ persists across runs
      // (the host-injected cache).
      //
      // We attach to `__ptc_pending_first__` the first call (by index) for
      // which the result is not yet cached at the moment callTool is hit.
      // The earlier "use last call" approach broke under Promise.all: all N
      // calls are recorded before any rejects, so `__ptc_calls__[len-1]`
      // pointed at an already-resolved call on subsequent iterations and
      // the host's defensive "re-requested after resolution" guard fired.
      const runScript = `(async function() {
        __ptc_calls__ = [];
        var __ptc_pending_first__ = null;
        try {
          var __r = await (async function() { ${script} })();
          return JSON.stringify({ done: true, result: typeof __r === 'string' ? __r : (__r == null ? '' : JSON.stringify(__r)) });
        } catch (e) {
          var msg = (e && e.message) || String(e);
          if (msg.indexOf(${JSON.stringify(`${PENDING_MARKER}:`)}) === 0) {
            // Find the FIRST recorded call whose result is not yet in
            // __ptc_results__ — that is the one the host needs to resolve
            // before progress can continue.
            var first = null;
            for (var i = 0; i < __ptc_calls__.length; i++) {
              var c = __ptc_calls__[i];
              if (!Object.prototype.hasOwnProperty.call(__ptc_results__, c.key)) {
                first = c;
                break;
              }
            }
            return JSON.stringify({ done: false, pending: first || __ptc_calls__[__ptc_calls__.length - 1] });
          }
          return JSON.stringify({ done: true, error: msg });
        }
      })()`;

      const execResult = await this.#kernel.run(runScript, this.#capabilities);
      const raw =
        typeof execResult.output === "string"
          ? execResult.output
          : JSON.stringify(execResult.output);

      let parsed: {
        done: boolean;
        result?: string;
        pending?: { key: string; name: string; args: Record<string, unknown> };
        error?: string;
      };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        output = raw;
        break;
      }

      if (parsed.done) {
        if (parsed.error) {
          throw new Error(parsed.error);
        }
        const finalResult = parsed.result ?? "";
        // Catch the case where the script wrote a try/catch around
        // `await callTool(...)` and silently swallowed our PENDING_MARKER
        // rejection — the script then "completes" with the marker text
        // visible in its return value. We detect by checking whether ANY
        // pending call existed but no resolution was performed in this
        // iteration. The marker substring is the second signal.
        if (typeof finalResult === "string" && finalResult.includes(PENDING_MARKER)) {
          throw new Error(
            "ProgrammaticOrchestrator: script swallowed the pause marker " +
              "(__PTC_PENDING__) inside a try/catch around callTool. Code-mode " +
              "scripts must let callTool's rejection propagate so the host " +
              "can resolve the call and re-run; do NOT catch errors that " +
              "begin with __PTC_PENDING__."
          );
        }
        output = finalResult;
        break;
      }

      // Not done — the script paused on a callTool that needs a host
      // round-trip. Resolve it and inject the result before re-running.
      if (!parsed.pending) {
        throw new Error("ProgrammaticOrchestrator: pause without pending call payload");
      }
      const { key, name, args } = parsed.pending;
      if (resolved.has(key)) {
        // Defensive: same key requested twice means we'd loop forever.
        throw new Error(
          `ProgrammaticOrchestrator: call ${name} (${key}) re-requested after resolution`
        );
      }
      const resultStr = await callTool(name, args ?? {});
      resolved.set(key, resultStr);
      const injectScript = `__ptc_results__[${JSON.stringify(key)}] = ${JSON.stringify(resultStr)};`;
      await this.#kernel.run(injectScript, this.#capabilities);
    }

    return output;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWrappedScript(script: string): string {
  return script.trim();
}

function buildToolRegistryPrelude(toolNames: string[]): string {
  return `var __available_tools__ = ${JSON.stringify(toolNames)};`;
}

export interface ProgrammaticResult {
  /** The script's final output — the only content that enters the LLM context. */
  finalOutput: string;
  /** Record of all intermediate tool calls made during script execution. */
  intermediateToolCalls: ToolCallRecord[];
  /** Total number of tool calls made during script execution. */
  toolCallCount: number;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  callId: string;
  result: unknown;
  isError: boolean;
}
