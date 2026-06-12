/**
 * local-offline — fully offline agent demo.
 *
 * Pulls a small GGUF model from the registry on first run (HuggingFace by
 * default; set AGENTKIT_MODEL_MIRROR=modelscope or hf-mirror for PRC hosts),
 * then runs a CodeAgent against a QuickJS sandbox kernel. After the first
 * download the demo runs with no network access at all — pull the plug,
 * re-run, the agent still answers.
 *
 * Prereqs:
 *   1. Install the optional native peer:  npm i node-llama-cpp
 *   2. Pull the model:                    npx agentkit model pull qwen3.5-0.8b
 *   3. Run:                               node examples/local-offline/index.mjs
 *
 * Why this example exists: it's the simplest realisation of agentkit-js's
 * "self-hosted intelligent agent" claim — model + execution + state, all
 * on the user's machine. No cloud LLM, no API key, no telemetry.
 */

import { CodeAgent } from "@agentkit-js/core";
import { LocalModel } from "@agentkit-js/model-local";

async function main() {
  const alias = process.env.LOCAL_MODEL_ALIAS ?? "qwen3.5-0.8b";

  // Step 1: load the local model. First run downloads (~530 MB for Qwen 0.8B).
  console.log(`[offline-demo] Loading model: ${alias} (first run downloads it)`);
  const model = new LocalModel({
    source: { model: alias },
    contextSize: 4096,
    temperature: 0.2,
    onDownloadProgress: (transferred, total) => {
      const pct = total > 0 ? ((transferred / total) * 100).toFixed(1) : "?";
      process.stderr.write(`\r  ${(transferred / 1e6).toFixed(0)} MB (${pct}%)`);
    },
  });

  // Eagerly load so the first generate() doesn't pay the warm-up cost mid-run.
  // If node-llama-cpp isn't installed, this throws a typed
  // LocalModelDependencyError with an actionable install hint.
  try {
    await model.load();
  } catch (e) {
    if (e?.name === "LocalModelDependencyError") {
      console.error(`\n${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  console.error("\n[offline-demo] Model loaded.");

  // Step 2: a QuickJS code kernel — fully sandboxed, no Node.js APIs reachable.
  const { QuickJSKernel } = await import("@agentkit-js/kernel-quickjs");
  const kernel = new QuickJSKernel();

  // Step 3: a CodeAgent that lets the model write JS and run it inside QuickJS.
  // No tool list — the kernel's eval is the action surface. Small models do
  // best with concrete numerical/string tasks; the system prompt template
  // for `localEndpoint:true` (in core's prompts) is automatically picked up.
  const agent = new CodeAgent({
    model,
    tools: [],
    kernel,
    maxSteps: 4,
  });

  const task =
    process.argv[2] ??
    "Compute the sum of squares from 1 to 10 using JavaScript and return the result.";

  console.error(`[offline-demo] Task: ${task}\n`);
  let final = "";
  for await (const ev of agent.run(task)) {
    if (ev.event === "step_start") process.stderr.write(`\n[step ${ev.data.step}] `);
    else if (ev.event === "thinking_delta") process.stdout.write(ev.data.delta);
    else if (ev.event === "tool_call") {
      console.log(
        `\n  → ${ev.data.toolName}(${JSON.stringify(ev.data.args).slice(0, 100)})`
      );
    } else if (ev.event === "tool_result") {
      console.log(
        `  ← ${ev.data.toolName} result: ${JSON.stringify(ev.data.output).slice(0, 100)}`
      );
    } else if (ev.event === "final_answer") {
      final = String(ev.data.answer ?? "");
    } else if (ev.event === "error") {
      console.error("[offline-demo] error:", ev.data);
    }
  }
  console.log("\n\n[offline-demo] Final answer:", final);
}

main().catch((e) => {
  console.error("[offline-demo] unhandled:", e);
  process.exit(1);
});
