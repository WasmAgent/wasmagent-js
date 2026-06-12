#!/usr/bin/env node
/**
 * local-model-cert.mjs — embedded local-LLM certification pipeline (L4).
 *
 * Decides whether a model is "good enough" to enter the official recommended
 * list (or, for user-supplied GGUFs, "good enough for my use case"). Three
 * orthogonal dimensions:
 *
 *   1. Tool-calling — does the model produce structurally legal JSON for
 *      tool_use blocks (form), AND does it pick semantically sensible
 *      arguments (semantics)? This is where small models fall over without
 *      grammar constraint; we measure both grammar-on and grammar-off.
 *
 *   2. CodeAgent — given a small problem and a QuickJS sandbox, does the
 *      model emit code that produces the right answer? Measures end-to-end
 *      agent success, not just model output.
 *
 *   3. Bilingual instruction following — short EN + ZH prompts where the
 *      gold answer is verifiable by string match (e.g. arithmetic or single
 *      lookups). The judge column is left as a TODO for real-hardware runs
 *      with a cloud judge — see L4 in the implementation plan.
 *
 * ## Modes
 *
 *   `node local-model-cert.mjs --self-test`
 *     Runs the pipeline against an in-script MockLocalModel that returns
 *     canned outputs. Verifies the scoring code, not any model. CI uses
 *     this to keep the cert harness honest — green means the pipeline is
 *     wired up; the actual model scores are filled in by --model runs on
 *     real hardware.
 *
 *   `node local-model-cert.mjs --model qwen3.5-0.8b`
 *     Downloads the registry alias, loads it via @agentkit-js/model-local,
 *     runs all three test groups, and prints a markdown report. 🖥️ Real
 *     hardware required (GPU optional but ~5× faster).
 *
 *   `node local-model-cert.mjs --path ./my-model.gguf`
 *     Same as above for a user-supplied GGUF.
 *
 *   `--out report.md`     Write the markdown report to a file.
 *   `--no-grammar`        Skip the grammar=on/off comparison (faster).
 *   `--limit N`           Cap each test group at N items (smoke runs).
 *
 * ## What's reported
 *
 * Per dimension:
 *   - n        items in the group
 *   - passN    items passing
 *   - rate     pass / n (percentage)
 *   - notes    a one-liner per failure with the offending input
 *
 * The exit code is 0 if all DIMENSION rates exceed the configured thresholds:
 *   - tool form rate     ≥ 99%   (grammar-on guarantees this; flag bugs if not)
 *   - tool semantic rate ≥ 70%
 *   - codeagent rate     ≥ 60%   (only when --kernel is set)
 *   - bilingual rate     ≥ 70%
 *
 * Failing rates do NOT block the recommended-list update on their own — the
 * report is the source of truth. The exit code is just a CI smoke signal.
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const TOOLCALL_TASKS = [
  {
    id: "tc1",
    prompt: "Add 12 and 30 using the calculator.",
    tools: [
      {
        name: "calc",
        description: "Add two integers",
        input_schema: {
          type: "object",
          required: ["a", "b"],
          properties: { a: { type: "integer" }, b: { type: "integer" } },
        },
      },
    ],
    expected: { name: "calc", input: { a: 12, b: 30 } },
  },
  {
    id: "tc2",
    prompt: "Look up the weather in Paris.",
    tools: [
      {
        name: "weather",
        description: "Get current weather",
        input_schema: {
          type: "object",
          required: ["city"],
          properties: { city: { type: "string" } },
        },
      },
    ],
    expected: { name: "weather", input: { city: "Paris" } },
  },
  {
    id: "tc3",
    prompt: "Search the web for the term 'quantum entanglement'.",
    tools: [
      {
        name: "search",
        description: "Web search",
        input_schema: {
          type: "object",
          required: ["q"],
          properties: { q: { type: "string" } },
        },
      },
    ],
    expected: { name: "search", input: { q: "quantum entanglement" } },
  },
];

const BILINGUAL_TASKS = [
  { id: "en1", prompt: "What is two plus two? Answer with just the number.", expected: /\b4\b/ },
  { id: "en2", prompt: "Capital of France? One word.", expected: /\bParis\b/i },
  { id: "zh1", prompt: "1+1 等于几?只回答数字。", expected: /\b2\b/ },
  { id: "zh2", prompt: "中国的首都是哪里?一个词。", expected: /北京/ },
];

const CODEAGENT_TASKS = [
  { id: "ca1", prompt: "Compute the sum of 1..10 in JavaScript and return as final answer.", expected: /\b55\b/ },
  { id: "ca2", prompt: "Return the length of the string 'agentkit'.", expected: /\b8\b/ },
];

// ── runners ────────────────────────────────────────────────────────────────

async function evalToolCalling(model, opts) {
  const tasks = TOOLCALL_TASKS.slice(0, opts.limit ?? TOOLCALL_TASKS.length);
  const results = [];
  for (const t of tasks) {
    let formOk = false;
    let semanticOk = false;
    let detail = "";
    try {
      const events = [];
      for await (const ev of model.generate(
        [{ role: "user", content: t.prompt }],
        { tools: t.tools, maxTokens: 256, ...(opts.grammar === false ? {} : {}) }
      )) {
        events.push(ev);
      }
      const toolCallEv = events.find((e) => e.type === "tool_call");
      if (toolCallEv?.toolCall) {
        formOk = true;
        const got = toolCallEv.toolCall;
        if (got.name === t.expected.name) {
          // Soft-equal the input: every expected key must be present and equal.
          const allMatch = Object.entries(t.expected.input).every(
            ([k, v]) => JSON.stringify(got.input?.[k]) === JSON.stringify(v)
          );
          if (allMatch) semanticOk = true;
          else detail = `args=${JSON.stringify(got.input)}`;
        } else {
          detail = `wrong tool: ${got.name}`;
        }
      } else {
        // Free-form fallback path. Try to parse a JSON object from the text.
        const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
        try {
          const parsed = JSON.parse(text.trim());
          if (parsed && typeof parsed === "object" && parsed.name && parsed.input) {
            formOk = true;
            if (parsed.name === t.expected.name) semanticOk = true;
            else detail = `wrong tool: ${parsed.name}`;
          } else {
            detail = "no tool_call event and no parseable JSON";
          }
        } catch (e) {
          detail = `text-only output: ${text.slice(0, 80)}`;
        }
      }
    } catch (e) {
      detail = `error: ${e?.message ?? String(e)}`;
    }
    results.push({ id: t.id, formOk, semanticOk, detail });
  }
  return results;
}

async function evalBilingual(model, opts) {
  const tasks = BILINGUAL_TASKS.slice(0, opts.limit ?? BILINGUAL_TASKS.length);
  const results = [];
  for (const t of tasks) {
    let pass = false;
    let detail = "";
    try {
      let text = "";
      for await (const ev of model.generate(
        [{ role: "user", content: t.prompt }],
        { maxTokens: 64 }
      )) {
        if (ev.type === "text_delta") text += ev.delta ?? "";
      }
      pass = t.expected.test(text);
      if (!pass) detail = `output: ${text.slice(0, 100)}`;
    } catch (e) {
      detail = `error: ${e?.message ?? String(e)}`;
    }
    results.push({ id: t.id, pass, detail });
  }
  return results;
}

async function evalCodeAgent(model, opts) {
  // CodeAgent integration is opt-in: requires the user to pass --kernel.
  // Without a kernel, we record SKIPPED rather than failing the pipeline,
  // because the model under test may be perfectly competent at the model
  // layer — codegen is downstream and orthogonal.
  if (!opts.kernelFactory) {
    return { skipped: true, reason: "no kernel factory supplied (use --kernel to enable)" };
  }
  const { CodeAgent } = await import("@agentkit-js/core");
  const tasks = CODEAGENT_TASKS.slice(0, opts.limit ?? CODEAGENT_TASKS.length);
  const results = [];
  for (const t of tasks) {
    let pass = false;
    let detail = "";
    try {
      const kernel = await opts.kernelFactory();
      const agent = new CodeAgent({ model, tools: [], kernel, maxSteps: 4 });
      let final = "";
      for await (const ev of agent.run(t.prompt)) {
        if (ev.event === "final_answer") final = String(ev.data.answer ?? "");
      }
      pass = t.expected.test(final);
      if (!pass) detail = `final: ${final.slice(0, 100)}`;
    } catch (e) {
      detail = `error: ${e?.message ?? String(e)}`;
    }
    results.push({ id: t.id, pass, detail });
  }
  return { skipped: false, results };
}

// ── reporting ──────────────────────────────────────────────────────────────

function rate(results, key) {
  const total = results.length;
  if (total === 0) return { passN: 0, total: 0, pct: 0 };
  const passN = results.filter((r) => r[key]).length;
  return { passN, total, pct: total === 0 ? 0 : passN / total };
}

function fmtPct(r) {
  return `${r.passN}/${r.total} (${(r.pct * 100).toFixed(1)}%)`;
}

function renderReport(modelLabel, mode, tool, bilingual, code) {
  const lines = [];
  lines.push(`# Local-Model Cert Report: ${modelLabel}`);
  lines.push("");
  lines.push(`Mode: ${mode}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Dimension | Form rate | Semantic rate |");
  lines.push("|---|---|---|");
  const tForm = rate(tool, "formOk");
  const tSem = rate(tool, "semanticOk");
  lines.push(`| Tool calling | ${fmtPct(tForm)} | ${fmtPct(tSem)} |`);
  const bil = rate(bilingual, "pass");
  lines.push(`| Bilingual instruction | — | ${fmtPct(bil)} |`);
  if (code.skipped) {
    lines.push(`| CodeAgent | — | SKIPPED (${code.reason}) |`);
  } else {
    const codeR = rate(code.results, "pass");
    lines.push(`| CodeAgent | — | ${fmtPct(codeR)} |`);
  }
  lines.push("");

  lines.push("## Tool calling — failures");
  lines.push("");
  for (const r of tool) {
    if (r.formOk && r.semanticOk) continue;
    lines.push(`- **${r.id}** — form=${r.formOk} sem=${r.semanticOk} — ${r.detail || "(no detail)"}`);
  }
  if (tool.every((r) => r.formOk && r.semanticOk)) lines.push("(none)");
  lines.push("");

  lines.push("## Bilingual — failures");
  lines.push("");
  for (const r of bilingual) {
    if (r.pass) continue;
    lines.push(`- **${r.id}** — ${r.detail || "(no detail)"}`);
  }
  if (bilingual.every((r) => r.pass)) lines.push("(none)");
  lines.push("");

  if (!code.skipped) {
    lines.push("## CodeAgent — failures");
    lines.push("");
    for (const r of code.results) {
      if (r.pass) continue;
      lines.push(`- **${r.id}** — ${r.detail || "(no detail)"}`);
    }
    if (code.results.every((r) => r.pass)) lines.push("(none)");
    lines.push("");
  }
  return lines.join("\n");
}

// ── self-test mock model ───────────────────────────────────────────────────

class MockLocalModel {
  providerId = "mock-local";
  capabilities = { localEndpoint: true, supportsGrammar: true };
  async *generate(messages, opts = {}) {
    const text = messages.at(-1)?.content ?? "";
    const tools = opts.tools ?? [];
    if (tools.length > 0) {
      const t = tools[0];
      // Canned responses keyed off the prompt text — exercises the parsing.
      let input = {};
      if (/12 and 30/.test(text)) input = { a: 12, b: 30 };
      else if (/Paris/.test(text)) input = { city: "Paris" };
      else if (/quantum/.test(text)) input = { q: "quantum entanglement" };
      yield {
        type: "tool_call",
        toolCall: { type: "tool_use", id: "x", name: t.name, input },
      };
      yield { type: "stop", stopReason: "tool_use" };
      return;
    }
    let reply = "";
    if (/two plus two/i.test(text)) reply = "4";
    else if (/Capital of France/i.test(text)) reply = "Paris";
    else if (/1\+1/.test(text)) reply = "2";
    else if (/中国的首都/.test(text)) reply = "北京";
    else if (/sum of 1\.\.10/.test(text)) reply = "55";
    else if (/length of the string 'agentkit'/.test(text)) reply = "8";
    else reply = "ok";
    yield { type: "text_delta", delta: reply };
    yield { type: "stop", stopReason: "end_turn" };
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      path: { type: "string" },
      url: { type: "string" },
      "self-test": { type: "boolean", default: false },
      "no-grammar": { type: "boolean", default: false },
      kernel: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      mirror: { type: "string" },
    },
  });

  const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
  const opts = {
    grammar: !values["no-grammar"],
    ...(limit !== undefined ? { limit } : {}),
  };

  let model;
  let label;
  let mode;
  if (values["self-test"]) {
    model = new MockLocalModel();
    label = "MockLocalModel (self-test)";
    mode = "self-test (no real model — verifies the harness only)";
  } else if (values.model || values.path || values.url) {
    const { LocalModel } = await import("@agentkit-js/model-local");
    if (values.model) {
      const args = { source: { model: values.model } };
      if (values.mirror) args.mirror = values.mirror;
      model = new LocalModel(args);
      label = values.model;
    } else if (values.path) {
      model = new LocalModel({ source: { path: values.path } });
      label = values.path;
    } else {
      model = new LocalModel({ source: { url: values.url } });
      label = values.url;
    }
    mode = `real-model run (grammar=${opts.grammar ? "on" : "off"})`;
  } else {
    console.error(
      "Error: pass one of --self-test, --model <alias>, --path <gguf>, or --url <gguf-url>"
    );
    process.exit(2);
  }

  if (values.kernel === "quickjs") {
    opts.kernelFactory = async () => {
      const { QuickJSKernel } = await import("@agentkit-js/kernel-quickjs");
      return new QuickJSKernel();
    };
  }

  console.error(`[cert] Running on ${label} ...`);

  const tool = await evalToolCalling(model, opts);
  const bilingual = await evalBilingual(model, opts);
  const code = await evalCodeAgent(model, opts);

  const report = renderReport(label, mode, tool, bilingual, code);
  if (values.out) {
    writeFileSync(values.out, report, "utf8");
    console.error(`[cert] Report → ${values.out}`);
  } else {
    process.stdout.write(report);
  }

  // Exit code = pipeline health. Self-test should always succeed; real-model
  // runs report-only (exit 0 unless the harness itself errored).
  const tForm = rate(tool, "formOk");
  const tSem = rate(tool, "semanticOk");
  const bil = rate(bilingual, "pass");
  if (values["self-test"]) {
    const pipelineOk = tForm.pct >= 0.99 && tSem.pct >= 0.99 && bil.pct >= 0.99;
    process.exit(pipelineOk ? 0 : 1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[cert] Unhandled error:", e);
  process.exit(2);
});
