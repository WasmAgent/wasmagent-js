/**
 * Eval suite example.
 *
 * Runs a small dataset through a ToolCallingAgent and scores it with
 * 6 scorers, printing a Markdown report to stdout.
 *
 * Required env:
 *   ANTHROPIC_API_KEY   — Claude model
 */
import { writeFile } from "node:fs/promises";
import {
  ToolCallingAgent,
  collectTrace,
  compositeScorer,
  constraintScorer,
  efficiencyScorer,
  exactMatch,
  finalAnswerLength,
  recoveryScorer,
  trajectoryValidity,
} from "@agentkit-js/core";
import { AnthropicModel } from "@agentkit-js/model-anthropic";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const model = new AnthropicModel("claude-sonnet-4-6", apiKey);
  const agent = new ToolCallingAgent({ tools: [], model, maxSteps: 5 });

  const dataset = [
    {
      id: "math-1",
      task: "What is 12 * 12? Answer with the number only.",
      expectedAnswer: "144",
    },
    {
      id: "math-2",
      task: "What is the square root of 144? Answer with the number only.",
      expectedAnswer: "12",
    },
    {
      id: "factual-1",
      task: "Who wrote the play 'Hamlet'? Answer with the name only.",
      expectedAnswer: "William Shakespeare",
    },
  ];

  // Composite scorer combining hard correctness with efficiency + length.
  const overall = compositeScorer(
    [
      { scorer: exactMatch, weight: 0.5 },
      { scorer: trajectoryValidity, weight: 0.1 },
      { scorer: efficiencyScorer({ maxTokens: 1000, maxDurationMs: 30_000 }), weight: 0.2 },
      { scorer: recoveryScorer(), weight: 0.1 },
      { scorer: constraintScorer({ maxLength: 60 }), weight: 0.05 },
      { scorer: finalAnswerLength(40), weight: 0.05 },
    ],
    "overall"
  );

  const scorers = [exactMatch, trajectoryValidity, efficiencyScorer({ maxTokens: 1000 }), overall];

  // Run each sample manually to also collect timing info.
  const rows = [];
  for (const sample of dataset) {
    const events = [];
    const start = Date.now();
    for await (const ev of agent.run(sample.task)) events.push(ev);
    const duration = Date.now() - start;

    const trace = collectTrace(sample.task, events);
    const scores = scorers.map((s) => s.score(trace, sample));

    rows.push({
      id: sample.id,
      task: sample.task,
      durationMs: duration,
      finalAnswer: trace.finalAnswer,
      scores,
    });
  }

  // Build markdown report.
  let md = "# Eval Suite Report\n\n";
  md += `Run at ${new Date().toISOString()} — ${rows.length} samples\n\n`;
  md += "| ID | Task | Final | Duration | " + scorers.map((s) => s.name).join(" | ") + " |\n";
  md += "|----|------|-------|---------:|" + scorers.map(() => "-:|").join("") + "\n";
  for (const r of rows) {
    const cells = r.scores.map((s) => s.score.toFixed(3));
    md += `| ${r.id} | ${r.task.slice(0, 50)} | ${(r.finalAnswer ?? "").slice(0, 30)} | ${r.durationMs}ms | ${cells.join(" | ")} |\n`;
  }

  // Aggregate
  md += "\n## Average\n\n";
  for (const s of scorers) {
    const avg = rows.reduce((acc, r) => acc + (r.scores.find((x) => x.scorer === s.name)?.score ?? 0), 0) / rows.length;
    md += `- **${s.name}**: ${avg.toFixed(3)}\n`;
  }

  console.log(md);
  await writeFile("./report.md", md);
  console.log("\n📄 Report written to ./report.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
