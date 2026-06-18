/**
 * Edge integration smoke: @wasmagent/evals-runner end-to-end against
 * a deterministic fake provider.
 *
 * No network, no token cost. Pins the contract:
 *   1. runEvaluation produces one cell per (model × seed × item).
 *   2. Aggregates correctly compute mean acc, Wilson CI, Pareto front.
 *   3. The markdown report has all required sections.
 *   4. The Pareto front identifies non-dominated models.
 *
 * 2026-06-16: pinned to `multi-turn-memory-original-6` (the 6-item
 * contract-test variant). The full `multi-turn-memory` suite grew to
 * 63 items as LoCoMo-style templates were added — fine for real evals,
 * but a smoke test wants a fixed denominator so the cell-count and
 * meanAcc numbers stay stable across suite enrichments.
 */
import {
  REFERENCE_SUITES,
  renderReportMarkdown,
  runEvaluation,
} from "@wasmagent/evals-runner";

let failed = 0;
function ok(label) {
  console.log(`✓ ${label}`);
}
function fail(label, detail) {
  console.error(`✗ ${label}`, detail ?? "");
  failed++;
}

// Fake provider: scripted answers per item id, with scripted token counts.
// Modeled on the 5-model run insight: a "small" model and a "large" model
// have the same correctness profile but differ in cost/latency.
function makeFakeProvider(profile) {
  return {
    async call({ model, messages }) {
      const userMsg = messages[messages.length - 1]?.content ?? "";
      // Heuristic: pick the answer based on which item we're on. We embed
      // recognizable substrings in the suite items so the fake can route.
      let content = "";
      if (/breed/i.test(userMsg)) content = "beagle";
      else if (/birthday/i.test(userMsg)) content = "March 12";
      else if (/car do I drive/i.test(userMsg)) content = "Rivian R1S";
      else if (/Acme Corp/i.test(userMsg)) content = profile.passS4 ? "1 year" : "January 5";
      else if (/favourite number/i.test(userMsg)) content = profile.passS5 ? "17" : "I don't recall";
      else if (/colour am I considering/i.test(userMsg)) content = "blue";
      else content = "";
      return {
        content,
        inputTokens: profile.in,
        outputTokens: profile.out,
      };
    },
  };
}

// ── 1. Run evaluation against 2 fake models, 1 suite, 2 seeds ────────────────

const models = [
  {
    id: "fake-small",
    baseUrl: "http://localhost:0",
    pricePer1MInput: 1.0,
    pricePer1MOutput: 4.0,
  },
  {
    id: "fake-large",
    baseUrl: "http://localhost:0",
    pricePer1MInput: 5.0,
    pricePer1MOutput: 20.0,
  },
];
// Pin to the 6-item original variant — see header docstring.
const suite = REFERENCE_SUITES["multi-turn-memory-original-6"];
if (!suite) throw new Error("REFERENCE_SUITES['multi-turn-memory-original-6'] missing");

// Run with two providers — small model fails S5, large model fails S4.
async function runWithProfiles() {
  // We can't pass per-model providers through runEvaluation directly (single
  // provider hook), so we run twice and merge — sufficient for the contract.
  const r1 = await runEvaluation(
    { models: [models[0]], suites: [suite], seeds: [0, 1] },
    makeFakeProvider({ passS4: false, passS5: false, in: 100, out: 30 })
  );
  const r2 = await runEvaluation(
    { models: [models[1]], suites: [suite], seeds: [0, 1] },
    makeFakeProvider({ passS4: true, passS5: true, in: 200, out: 80 })
  );
  return { r1, r2 };
}

const { r1, r2 } = await runWithProfiles();

// 2 models × 1 suite × 2 seeds × 6 items = 24 cells total across the two runs.
if (r1.cells.length !== 12) fail(`small: 12 cells expected, got ${r1.cells.length}`);
else ok("small model: 12 cells produced (1×2×6)");
if (r2.cells.length !== 12) fail(`large: 12 cells expected, got ${r2.cells.length}`);
else ok("large model: 12 cells produced");

// ── 2. Aggregate sanity ─────────────────────────────────────────────────────

const r1agg = r1.aggregates[0];
const r2agg = r2.aggregates[0];

// Small model: passes S1, S2, S3, S6 (4 of 6) per profile → 4/6 = 66.7%.
if (Math.abs(r1agg.meanAcc - 4 / 6) > 0.01) {
  fail(`small meanAcc: expected 0.667, got ${r1agg.meanAcc}`);
} else ok(`small model meanAcc = 4/6 (${(r1agg.meanAcc * 100).toFixed(1)}%)`);

// Large model: passes all 6 → 100%.
if (Math.abs(r2agg.meanAcc - 1.0) > 0.01) {
  fail(`large meanAcc: expected 1.0, got ${r2agg.meanAcc}`);
} else ok("large model meanAcc = 6/6 (100%)");

// Wilson CI on small (8/12 over 2 seeds).
if (r1agg.wilsonLo >= r1agg.wilsonHi) fail("small: degenerate Wilson CI", r1agg);
else ok(`small Wilson CI: [${(r1agg.wilsonLo * 100).toFixed(1)}%, ${(r1agg.wilsonHi * 100).toFixed(1)}%]`);

// ── 3. Cost differs as expected ─────────────────────────────────────────────

// Small: 12 cells × (100 input + 30 output) → 1200 in + 360 out = 0.0012 + 0.00144 = $0.00264
// Large: 12 cells × (200 input + 80 output) → 2400 in + 960 out = 0.012 + 0.0192 = $0.0312
if (r1agg.totalCostUsd >= r2agg.totalCostUsd) {
  fail(`cost ordering: small ($${r1agg.totalCostUsd}) should be less than large ($${r2agg.totalCostUsd})`);
} else ok(`cost ordering: small $${r1agg.totalCostUsd.toFixed(4)} < large $${r2agg.totalCostUsd.toFixed(4)}`);

// ── 4. Pareto front (combined run) ──────────────────────────────────────────

const combined = await runEvaluation(
  { models, suites: [suite], seeds: [0] },
  makeFakeProvider({ passS4: true, passS5: true, in: 150, out: 50 })
);
// Both models give identical accuracy here (same fake provider) — but the
// large model has 5× the per-token price, so on (acc, cost, p95) the small
// model strictly dominates the large one (same acc, lower cost). The front
// should therefore contain ONLY the small model. This is exactly the
// insight the Pareto framing is supposed to surface — and the canonical
// reason a smaller / cheaper model can be the right deployment choice when
// quality is at parity.
const front = combined.pareto[0]?.front ?? [];
if (front.length !== 1) {
  fail(`pareto: 1 model on front expected (small dominates on cost), got ${front.length}`);
} else if (front[0].modelId !== "fake-small") {
  fail(`pareto: small model expected on front, got ${front[0].modelId}`);
} else ok(`pareto: small model alone on front (dominates on cost at parity acc)`);

// ── 5. Markdown report shape ────────────────────────────────────────────────

const md = renderReportMarkdown(combined);
if (!md.includes("# Evaluation Report")) fail("report missing title");
else ok("report has title");
if (!md.includes("Mean acc")) fail("report missing summary table");
else ok("report has summary table");
if (!md.includes("Pareto front")) fail("report missing pareto callout");
else ok("report has pareto callout");
if (!md.includes("multi-turn-memory")) fail("report missing per-suite breakdown");
else ok("report has per-suite breakdown");

// ── 6. REFERENCE_SUITES catalogue ──────────────────────────────────────────

const expectedSuites = [
  "multi-turn-memory",
  "long-context-recall",
  "cost-per-correct",
  "tool-sequence",
  "agent-trajectory",
  "latency-under-budget",
];
for (const name of expectedSuites) {
  if (!REFERENCE_SUITES[name]) fail(`REFERENCE_SUITES missing ${name}`);
}
ok(`REFERENCE_SUITES has all 6 reference suites`);

if (failed > 0) {
  console.error(`\n[edge-evals-runner] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[edge-evals-runner] all checks passed`);
process.exit(0);
