#!/usr/bin/env node

/**
 * agentkit-evals — independent CLI for the @agentkit-js/evals-runner.
 *
 * # Why a separate bin from `agentkit evals run`
 *
 * `@agentkit-js/cli` exposes the same evals surface via
 * `agentkit evals run …`, but pulls in every transitive dep that the
 * multi-tool needs (devtools, model adapters, etc.). The independent
 * `agentkit-evals` binary lets eval-only consumers (CI matrix runners,
 * researchers comparing models, our own regression harness) install
 * just `@agentkit-js/evals-runner` and get a usable CLI without
 * pulling in the rest of agentkit's surface area.
 *
 * Until 2026-06-18 this binary was a *dead link* — `package.json`
 * declared `bin: "./dist/cli.js"` but `src/cli.ts` did not exist.
 * See `docs/strategy/cli-gap-analysis-2026-06-18.md` (G1).
 *
 * # Surface
 *
 *   agentkit-evals list
 *     Print available reference suites + descriptions.
 *
 *   agentkit-evals run \
 *     --suite=<name>[,<name>…] \
 *     --models=<id>[@baseUrl][#wireModelId][,…] \
 *     [--seeds=0,1,2] \
 *     [--base-url=<fallback baseUrl>] \
 *     [--report-file=path.md] \
 *     [--json]
 *     Run the named suites against the listed models. Prints a Markdown
 *     report (or JSON if --json) — same machinery `agentkit evals run`
 *     uses, but standalone.
 *
 *   agentkit-evals --help / -h
 *   agentkit-evals --version / -v
 *
 * # Deliberate non-goals
 *
 * No `init`, no `run` of arbitrary tasks, no model bootstrapping. This
 * binary is **only** for evaluation. Anything else: install
 * `@agentkit-js/cli` and use `agentkit`.
 */

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type ModelSpec, REFERENCE_SUITES, renderReportMarkdown, runEvaluation } from "./index.js";

// Source-of-truth synced manually from package.json on each release.
// Same approach as packages/cli/src/index.ts — runtime path resolution
// of `../package.json` differs between npm-installed and workspace-
// symlinked layouts, so a literal is the safe default.
const VERSION = "0.1.0";

const HELP = `agentkit-evals — eval runner for @agentkit-js/evals-runner

USAGE
  agentkit-evals list
  agentkit-evals run --suite=<name>[,<name>…] --models=<spec>[,<spec>…]

OPTIONS
  --suite=<name,…>      Comma-separated suite names (try \`agentkit-evals list\`).
  --models=<spec,…>     Comma-separated model specs.
                        Format: <id>[@<baseUrl>][#<wireModelId>]
                        baseUrl falls back to --base-url when omitted.
                        Example: --models="qwen2.5:0.5b@http://localhost:11434/v1"
  --seeds=0,1,2         Random seeds (comma-separated ints). Default: 0,1,2.
  --base-url=<url>      Fallback OpenAI-compat /chat/completions endpoint
                        when a model spec omits @baseUrl.
                        Default: http://localhost:11434/v1
  --report-file=<path>  Write the Markdown report to this file.
                        Default: print to stdout.
  --json                Emit the full EvaluationReport as JSON instead
                        of Markdown. Useful for downstream tooling.
  --help, -h            Print this help.
  --version, -v         Print the binary version.

EXAMPLES
  # List what's available.
  agentkit-evals list

  # Run a single suite against a local Ollama.
  agentkit-evals run \\
    --suite=tool-sequence \\
    --models="qwen2.5:0.5b@http://localhost:11434/v1"

  # Compare two models on two suites; write Markdown report to file.
  agentkit-evals run \\
    --suite=tool-sequence,latency-under-budget \\
    --models="model-a@http://a.local/v1,model-b@http://b.local/v1" \\
    --seeds=0,1,2,3,4 \\
    --report-file=eval-report.md

NOTES
  - This binary is a thin wrapper over runEvaluation() from
    @agentkit-js/evals-runner. Anything you can do here you can do in
    a Node script that imports the same module.
  - For the multi-tool experience (run, init-tool, devtools, model)
    install @agentkit-js/cli and use \`agentkit evals run\` instead;
    the underlying runner is the same.
`;

function fail(msg: string, exitCode = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(exitCode);
}

function parseModelSpec(spec: string, fallbackBaseUrl: string): ModelSpec {
  // Format: id@baseUrl#modelId. Both @baseUrl and #modelId are optional.
  // The spec library lets the same "id" reuse the global --base-url; the
  // fallback only applies when @ is missing OR @ is present but empty
  // (e.g. `display@#wire-name`).
  const atIdx = spec.indexOf("@");
  const id = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
  const tail = atIdx >= 0 ? spec.slice(atIdx + 1) : "";
  const hashIdx = tail.indexOf("#");
  const rawBaseUrl = hashIdx >= 0 ? tail.slice(0, hashIdx) : tail;
  const baseUrl = rawBaseUrl || fallbackBaseUrl;
  const modelId = hashIdx >= 0 ? tail.slice(hashIdx + 1) : id;
  return { id, baseUrl, modelId };
}

async function listCommand(): Promise<void> {
  process.stdout.write("Available reference suites:\n");
  for (const [name, suite] of Object.entries(REFERENCE_SUITES)) {
    process.stdout.write(`  ${name.padEnd(28)} — ${suite.title}\n`);
    process.stdout.write(`    ${suite.description}\n`);
  }
  process.stdout.write("\nRun with:  agentkit-evals run --suite=<name,…> --models=<spec,…>\n");
}

async function runCommand(opts: Record<string, string | boolean | undefined>): Promise<void> {
  const suiteNames = String(opts.suite ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (suiteNames.length === 0) {
    fail("Error: --suite=<name,…> is required (try `agentkit-evals list`).");
  }
  const suites = suiteNames.map((n) => {
    const s = REFERENCE_SUITES[n];
    if (!s) fail(`Unknown suite: ${n}. Try \`agentkit-evals list\`.`);
    return s;
  });

  const modelsRaw = String(opts.models ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (modelsRaw.length === 0) {
    fail(
      "Error: --models=<id[@url][#modelId],…> is required.\n" +
        '  Example: --models="qwen2.5:0.5b@http://localhost:11434/v1"'
    );
  }
  const fallbackBaseUrl = (opts["base-url"] as string | undefined) ?? "http://localhost:11434/v1";
  const models = modelsRaw.map((spec) => parseModelSpec(spec, fallbackBaseUrl));

  const seeds = String(opts.seeds ?? "0,1,2")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
  if (seeds.length === 0) {
    fail("Error: --seeds parsed to zero valid integers.");
  }

  process.stderr.write(
    `[evals] ${models.length} model(s) × ${suites.length} suite(s) × ${seeds.length} seed(s)\n`
  );

  const report = await runEvaluation({
    models,
    suites,
    seeds,
    onProgress: (done, total) => {
      // Throttled progress on stderr so --report-file=- (stdout) stays clean.
      if (done < 0) return; // warmup hint
      if (done === total || done % 10 === 0) {
        const pct = total > 0 ? ((done / total) * 100).toFixed(1) : "?";
        process.stderr.write(`\r[evals] ${done}/${total} (${pct}%)`);
      }
    },
  });
  process.stderr.write("\n");

  const reportFile = opts["report-file"] as string | undefined;
  const asJson = opts.json === true;
  const payload = asJson ? JSON.stringify(report, null, 2) : renderReportMarkdown(report);

  if (reportFile) {
    await writeFile(reportFile, payload, "utf8");
    process.stderr.write(`Report → ${reportFile}\n`);
  } else {
    process.stdout.write(`${payload}\n`);
  }

  // Exit non-zero if any cell failed catastrophically (no successes).
  // Per-suite passing semantics live in the suite — they bubble through
  // the report; we only flag the catastrophic case here.
  const anyAttempted = report.cells?.length ?? 0;
  const anyOk = (report.cells ?? []).some((c) => !c.error);
  if (anyAttempted > 0 && !anyOk) {
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      suite: { type: "string" },
      models: { type: "string" },
      seeds: { type: "string", default: "0,1,2" },
      "base-url": { type: "string" },
      "report-file": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const [command] = positionals;
  switch (command) {
    case "list":
      await listCommand();
      break;
    case "run":
      await runCommand(values);
      break;
    default:
      fail(
        `Unknown command: ${command}. Use 'list' or 'run'. (\`agentkit-evals --help\` for full usage.)`
      );
  }
}

// Only dispatch when invoked as a binary, not when imported by tests.
const isMain =
  process.argv[1] != null &&
  new URL(import.meta.url).pathname.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").at(-1) ?? ""
  );
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`agentkit-evals: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

// Exported for tests.
export { HELP, parseModelSpec, VERSION };
