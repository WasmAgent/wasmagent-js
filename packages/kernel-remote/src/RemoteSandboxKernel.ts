import {
  type CapabilityManifest,
  type KernelOptions,
  type KernelResult,
  resolveEffectiveCapabilities,
  type WasmKernel,
} from "@wasmagent/core/executor";

export interface RemoteSandboxOptions extends KernelOptions {
  /** E2B API key. Defaults to process.env.E2B_API_KEY. */
  apiKey?: string;
  /** E2B sandbox template ID. Default: "base" */
  template?: string;
  /** Timeout for each code execution in milliseconds. Default: 30_000 */
  timeoutMs?: number;
  /**
   * FAIL-CLOSED acknowledgment: this kernel cannot enforce network-egress
   * policy (no firewall). Default false — run() rejects unless explicitly
   * acknowledged.
   */
  allowUnrestrictedNetwork?: boolean;
  /**
   * FAIL-CLOSED acknowledgment: this kernel cannot enforce FS allow-lists
   * (the guest has unrestricted access to its own microVM filesystem).
   * Default false — run() rejects unless explicitly acknowledged.
   */
  allowUnrestrictedSandboxFs?: boolean;
}

/** Result of a shell command execution via runCommand(). */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * RemoteSandboxKernel — microVM third isolation tier via E2B.
 *
 * Each run() executes code inside a fully isolated microVM (E2B cloud sandbox).
 * This provides process-level isolation: the agent code runs in a separate VM,
 * completely disconnected from the host process memory.
 *
 * Security properties:
 *   - True microVM isolation: E2B spins up a firecracker microVM per sandbox.
 *   - Network policy: NOT ENFORCED by this kernel. CapabilityManifest.allowedHosts
 *     is rejected at run() (fail closed) because the E2B egress firewall is not
 *     wired in — an unrestricted-network sandbox must be acknowledged explicitly.
 *   - FS isolation: the microVM has its own ephemeral filesystem, no host access.
 *   - Memory: memoryLimitBytes is not enforceable here and is likewise rejected.
 *
 * Cross-run state:
 *   The sandbox is REUSED across run() calls until reset()/dispose() — the
 *   opposite of the historical docstring. Filesystem and process state persist
 *   across calls within one sandbox lifetime. Treat each run as sharing a
 *   session; for fresh isolation, call reset() between runs.
 *   (keepAlive/ephemeral-per-run semantics are on the roadmap.)
 *
 * Prerequisites:
 *   `e2b` npm package must be installed:
 *     pnpm add e2b
 *   E2B API key required in E2B_API_KEY env var or passed via options.
 *
 * @example
 * ```ts
 * import { RemoteSandboxKernel } from "@wasmagent/kernel-remote";
 * await using kernel = new RemoteSandboxKernel({ apiKey: process.env.E2B_API_KEY });
 * const result = await kernel.run("console.log('hello from microVM')");
 * console.log(result.logs); // ["hello from microVM"]
 * ```
 */
export class RemoteSandboxKernel implements WasmKernel {
  readonly #opts: RemoteSandboxOptions;
  #sandbox: E2BSandbox | null = null;

  constructor(opts: RemoteSandboxOptions = {}) {
    this.#opts = opts;
  }

  /**
   * One authority gate shared by every execution path (run, runCommand):
   * merges constructor + per-call capabilities restrictively, rejects any
   * restriction this kernel cannot enforce, and requires the explicit
   * unrestricted-environment acknowledgments. Must be called BEFORE
   * #getSandbox() so a rejected policy never allocates a remote sandbox.
   */
  #resolveAndAssertExecutionPolicy(
    capabilities?: Partial<CapabilityManifest>
  ): Partial<CapabilityManifest> {
    const merged = resolveEffectiveCapabilities(this.#opts.capabilities, capabilities);

    // A defined list IS a requested restriction — deny-all ([], per the
    // manifest contract) counts too, and none of these can be enforced here.
    if (Array.isArray(merged.allowedHosts)) {
      throw new Error(
        "RemoteSandboxKernel cannot enforce a network allow-list (no egress firewall; " +
          "an empty list requests deny-all, which is equally unenforceable). Use a kernel " +
          "with hard network enforcement."
      );
    }
    if (Array.isArray(merged.allowedReadPaths) || Array.isArray(merged.allowedWritePaths)) {
      throw new Error(
        "RemoteSandboxKernel cannot enforce filesystem allow-lists (the guest has " +
          "unrestricted access to its own microVM filesystem). Use a kernel with hard " +
          "FS enforcement, or acknowledge an unrestricted sandbox filesystem."
      );
    }
    if (merged.memoryLimitBytes !== undefined) {
      throw new Error(
        "RemoteSandboxKernel cannot enforce a memory cap (no provider memory policy " +
          "wired in). Use a kernel with hard enforcement."
      );
    }
    if (
      this.#opts.allowUnrestrictedNetwork !== true ||
      this.#opts.allowUnrestrictedSandboxFs !== true
    ) {
      throw new Error(
        "RemoteSandboxKernel cannot enforce network-egress or sandbox-FS policy. " +
          "Set allowUnrestrictedNetwork: true and allowUnrestrictedSandboxFs: true in " +
          "RemoteSandboxOptions to acknowledge an unrestricted-network, sandbox-FS-only " +
          "environment, or use a kernel with hard enforcement (JsKernel / QuickJSKernel)."
      );
    }
    return merged;
  }

  async run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult> {
    // FAIL CLOSED — default deny. This kernel cannot enforce network egress
    // or FS allow-lists: without explicit acknowledgment, ANY execution would
    // run with unrestricted network/FS inside the microVM, which the
    // CapabilityManifest contract treats as a lie about isolation.
    //
    // Semantics:
    //   allowUnrestrictedNetwork = false (default) → reject.
    //   allowUnrestrictedNetwork = true            → may execute; but a
    //     requested allow-list STILL rejects — we cannot enforce it.
    //   memoryLimitBytes requested                 → always reject (no
    //     enforcement exists in this kernel).
    // Constructor capabilities and per-call capabilities merge restrictively
    // (resolveEffectiveCapabilities); the acknowledgment flags are NOT part
    // of the manifest and cannot be widened per-call.
    const merged = this.#resolveAndAssertExecutionPolicy(capabilities);

    const sandbox = await this.#getSandbox();
    // "Lower value wins": per-call limits may narrow, never widen, the
    // constructor ceiling (@wasmagent/core/executor contract).
    const timeoutMs = Math.min(
      merged.cpuMs ?? Number.POSITIVE_INFINITY,
      this.#opts.timeoutMs ?? Number.POSITIVE_INFINITY
    );
    const effectiveTimeoutMs = timeoutMs === Number.POSITIVE_INFINITY ? 30_000 : timeoutMs;

    // Use effective capabilities (not raw per-call) for harness construction.
    const harness = buildHarness(code, merged);

    const execution = await sandbox.runCode(harness, { timeoutMs: effectiveTimeoutMs });
    const logs = execution.logs.stdout.concat(execution.logs.stderr);

    // Parse structured output from stdout if present.
    const lastStdout = execution.logs.stdout.at(-1) ?? "";
    let output: unknown;
    let isFinalAnswer = false;

    try {
      const parsed = JSON.parse(lastStdout) as { __output?: unknown; __isFinalAnswer?: boolean };
      if (typeof parsed === "object" && parsed !== null && "__output" in parsed) {
        output = parsed.__output;
        isFinalAnswer = parsed.__isFinalAnswer === true;
        // Remove the structured output line from logs.
        logs.splice(logs.indexOf(lastStdout), 1);
      }
    } catch {
      // Not structured output — treat as plain text.
      output = execution.logs.stdout.join("\n") || undefined;
    }

    return { output, logs, isFinalAnswer };
  }

  async reset(): Promise<void> {
    if (this.#sandbox) {
      await this.#sandbox.kill();
      this.#sandbox = null;
    }
  }

  /**
   * Run a shell command inside the sandbox and return structured output.
   *
   * SECURITY: this method executes a real shell command inside the microVM.
   * It is gated by the SAME authority gate as run() — the shared policy check
   * (constructor ceiling + per-call narrowing + unenforceable-restriction
   * rejection + the allowUnrestrictedNetwork / allowUnrestrictedSandboxFs
   * acknowledgments) runs BEFORE the sandbox is created, so a rejected policy
   * never allocates anything remote.
   */
  async runCommand(
    cmd: string,
    capabilities?: Partial<CapabilityManifest>
  ): Promise<CommandResult> {
    const merged = this.#resolveAndAssertExecutionPolicy(capabilities);
    const sandbox = await this.#getSandbox();
    // "Lower value wins": per-call limits may narrow, never widen, the
    // constructor ceiling (@wasmagent/core/executor contract) — same as run().
    const timeoutMs = Math.min(
      merged.cpuMs ?? Number.POSITIVE_INFINITY,
      this.#opts.timeoutMs ?? Number.POSITIVE_INFINITY
    );
    const effectiveTimeoutMs = timeoutMs === Number.POSITIVE_INFINITY ? 30_000 : timeoutMs;
    const result = await sandbox.commands.run(cmd, { timeoutMs: effectiveTimeoutMs });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.reset();
  }

  async #getSandbox(): Promise<E2BSandbox> {
    if (!this.#sandbox) {
      const { Sandbox } = await loadE2B();
      this.#sandbox = (await Sandbox.create({
        template: this.#opts.template ?? "base",
        apiKey: this.#opts.apiKey ?? process.env.E2B_API_KEY,
      })) as E2BSandbox;
    }
    return this.#sandbox;
  }
}

// ── Harness builder ──────────────────────────────────────────────────────────

function buildHarness(code: string, capabilities?: Partial<CapabilityManifest>): string {
  const allowedHosts = capabilities?.allowedHosts ?? [];
  const env = capabilities?.env ?? {};
  const networkGuard =
    allowedHosts.length === 0
      ? "// Network: deny-all (no allowedHosts specified)"
      : `// Network: allowed hosts = ${JSON.stringify(allowedHosts)}`;
  // Capability env injected as a frozen __env__ global. The remote sandbox
  // process has its own process.env (sandbox-image defaults); we surface only
  // the manifest's env via the canonical __env__ name to match the JS kernels.
  // Code that reads process.env still works (E2B's defaults), but anything
  // user-supplied per call comes through __env__.
  const envLiteral = JSON.stringify(env);

  return [
    `// WasmAgent RemoteSandboxKernel harness`,
    networkGuard,
    `globalThis.__env__ = Object.freeze(${envLiteral});`,
    `var __finalAnswer__ = undefined;`,
    `var __final_answer__ = undefined;`,
    `try {`,
    `  const __result = await (async () => { ${code} })();`,
    `  const __fa = __finalAnswer__ !== undefined ? __finalAnswer__ : __final_answer__;`,
    `  const __isFinal = __fa !== undefined;`,
    `  process.stdout.write(JSON.stringify({ __output: __isFinal ? __fa : __result, __isFinalAnswer: __isFinal }) + "\\n");`,
    `} catch (e) {`,
    `  process.stdout.write(JSON.stringify({ __output: null, __isFinalAnswer: false, __error: String(e) }) + "\\n");`,
    `  process.exit(1);`,
    `}`,
  ].join("\n");
}

// Exposed for unit testing — build the harness string without a sandbox.
export function _buildHarnessForTest(
  code: string,
  capabilities?: Partial<CapabilityManifest>
): string {
  return buildHarness(code, capabilities);
}

// ── E2B dynamic import ───────────────────────────────────────────────────────

interface E2BSandbox {
  runCode(
    code: string,
    opts?: { timeoutMs?: number }
  ): Promise<{
    logs: { stdout: string[]; stderr: string[] };
  }>;
  commands: {
    run(
      cmd: string,
      opts?: { timeoutMs?: number }
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  kill(): Promise<void>;
}

interface E2BModule {
  Sandbox: {
    create(opts: { template?: string; apiKey?: string | undefined }): Promise<unknown>;
  };
}

async function loadE2B(): Promise<E2BModule> {
  try {
    return (await import("e2b")) as E2BModule;
  } catch (cause) {
    const err = new Error(
      "@wasmagent/kernel-remote requires the 'e2b' package.\n" +
        "  Install: pnpm add e2b\n" +
        "  Docs: https://e2b.dev/docs"
    ) as Error & { code: string; cause: unknown };
    err.code = "KERNEL_NOT_INSTALLED";
    err.cause = cause;
    throw err;
  }
}
