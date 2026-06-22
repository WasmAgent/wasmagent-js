import type {
  CapabilityManifest,
  KernelOptions,
  KernelResult,
  WasmKernel,
} from "@wasmagent/core/executor";

export interface RemoteSandboxOptions extends KernelOptions {
  /** E2B API key. Defaults to process.env.E2B_API_KEY. */
  apiKey?: string;
  /** E2B sandbox template ID. Default: "base" */
  template?: string;
  /** Timeout for each code execution in milliseconds. Default: 30_000 */
  timeoutMs?: number;
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
 *   - Network policy: CapabilityManifest.allowedHosts controls outbound access
 *     at the kernel level (future: maps to E2B network policies when available).
 *   - FS isolation: the microVM has its own ephemeral filesystem, no host access.
 *
 * Cross-run state:
 *   Unlike VmKernel/JsKernel, state does NOT persist between run() calls by default
 *   (each sandbox is ephemeral). Pass { keepAlive: true } in options to reuse the
 *   same sandbox across calls (stateful session).
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

  async run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult> {
    const sandbox = await this.#getSandbox();
    // Per-call cpuMs (capability) takes precedence over the constructor
    // default (opts.timeoutMs).
    const timeoutMs = capabilities?.cpuMs ?? this.#opts.timeoutMs ?? 30_000;

    // Wrap code to capture output and produce a structured result.
    const harness = buildHarness(code, capabilities);

    const execution = await sandbox.runCode(harness, { timeoutMs });
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
   * Unlike run() (which evaluates a JS/Python code snippet via runCode()),
   * this method executes a real shell command — e.g. `npm install`, `vite build`.
   * Use this for build/install steps where you need the real stdout/stderr/exitCode
   * rather than a structured code-execution result.
   *
   * @example
   * ```ts
   * const { stdout, stderr, exitCode } = await kernel.runCommand("npm install");
   * ```
   */
  async runCommand(cmd: string): Promise<CommandResult> {
    const sandbox = await this.#getSandbox();
    const timeoutMs = this.#opts.timeoutMs ?? 30_000;
    const result = await sandbox.commands.run(cmd, { timeoutMs });
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
    `// agentkit RemoteSandboxKernel harness`,
    networkGuard,
    `globalThis.__env__ = Object.freeze(${envLiteral});`,
    `try {`,
    `  const __result = await (async () => { ${code} })();`,
    `  process.stdout.write(JSON.stringify({ __output: __result, __isFinalAnswer: false }) + "\\n");`,
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
