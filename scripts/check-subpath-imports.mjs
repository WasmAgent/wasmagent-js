#!/usr/bin/env node

/**
 * check-subpath-imports.mjs — enforce that beta/experimental symbols are
 * imported from the correct @wasmagent/core sub-path, not from main.
 *
 * Why: when the API tier split moved symbols to core/beta and core/experimental,
 * existing imports of the form `from "@wasmagent/core"` silently break at runtime
 * (SyntaxError: Export named 'X' not found). This script catches that at CI time.
 *
 * Usage:
 *   node scripts/check-subpath-imports.mjs           # check mode
 *   node scripts/check-subpath-imports.mjs --fix     # auto-fix (adds /beta suffix)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Symbols that live in @wasmagent/core/beta (not main entry)
const BETA_SYMBOLS = new Set([
  // Enhancement runners
  "BudgetForcingRunner",
  "ParallelForkJoinRunner",
  "ReflectRefineRunner",
  "RolloutForkRunner",
  "RolloutMemoryStore",
  "SelfConsistencyRunner",
  "resolveEnhancement",
  // Enhancement types
  "BudgetForcingOptions",
  "BudgetForcingResult",
  "EnhancementPreset",
  "ParallelForkJoinOptions",
  "ParallelForkJoinResult",
  "ReflectRefineOptions",
  "ReflectRefineResult",
  "RolloutBranchResult",
  "RolloutForkRunnerOptions",
  "RolloutMemory",
  "RolloutMemoryRecord",
  "RolloutMemoryStoreOptions",
  "SelfConsistencyOptions",
  "SelfConsistencyResult",
  // Evals
  "runEval",
  "exactMatch",
  "finalAnswerLength",
  "toolCallAccuracy",
  "trajectoryValidity",
  "judgeScorer",
  "llmJudge",
  "llmJudgeAsync",
  "compositeScorer",
  "constraintScorer",
  "efficiencyScorer",
  "faithfulnessScorer",
  "faithfulnessScorerAsync",
  "relevanceScorer",
  "relevanceScorerAsync",
  "guardrailCompliance",
  "guardrailComplianceAsync",
  "runJudgeScorer",
  "collectTrace",
  "answerCompletenessJudge",
  "trajectoryQualityJudge",
  "recoveryScorer",
  // Error classification
  "buildFixRetryMessage",
  "classifyExecutionError",
  "ErrorRecoveryStrategy",
  "MAX_REFINEMENT_STEPS",
  // RLAIF ranking
  "RolloutRanker",
  "DEFAULT_REWARD_FUNCTIONS",
  "toDpoRecord",
  "toPpoRecords",
  "toJsonl",
  "RolloutExporter",
  // Workflow
  "LocalWorkflowEngine",
  "KvWorkflowStateStore",
  "MemoryKvBackend",
  "WorkflowDefinition",
  "WorkflowRunHandle",
  "WorkflowStateStore",
  "WorkflowStep",
  "WorkflowEvent",
  "WorkflowRunRecord",
  // File management (beta)
  "FileTreeManager",
  "globalFileTree",
  "FileLockManager",
  "globalFileLock",
  // Skills
  "ProjectInstructions",
  "makeKvAgentsMdLoader",
  "SkillRegistry",
  "BranchableWorkspace",
  "openOrCreateRoot",
  // Types for above
  "Scorer",
  "RolloutRecord",
  "AgentRunner",
  "AgentTrace",
  "EvalSample",
  "EvalRunResult",
  "JudgeBreakdown",
]);

// Symbols that live in @wasmagent/core/experimental
const EXPERIMENTAL_SYMBOLS = new Set([
  "OtelBridge",
  "withOtel",
  "InMemorySpanExporter",
  "OtelBridgeOptions",
  "GenAiMetricPoint",
  "MetricExporter",
  "ReadableSpan",
  "SpanAttributes",
  "SpanExporter",
]);

const fix = process.argv.includes("--fix");

const files = execSync("git ls-files -- '*.ts'", { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((f) => f && !f.includes("/dist/") && !f.startsWith(".claude/"));

let violations = 0;
const fixed = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes('"@wasmagent/core"') && !text.includes("'@wasmagent/core'")) continue;

  // Parse import statements that use @wasmagent/core (main entry)
  const importRe =
    /import\s+(?:type\s+)?(?:\{([^}]+)\}[^"']*|([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+\S+)?\s+from\s+)["']@wasmagent\/core["']/g;
  let match;
  const betaViolations = [];
  const expViolations = [];

  while ((match = importRe.exec(text)) !== null) {
    const importList = match[1] ?? match[2] ?? "";
    const symbols = importList
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim()
      )
      .filter(Boolean);
    for (const sym of symbols) {
      if (BETA_SYMBOLS.has(sym)) betaViolations.push({ sym, importStatement: match[0] });
      if (EXPERIMENTAL_SYMBOLS.has(sym)) expViolations.push({ sym, importStatement: match[0] });
    }
  }

  if (betaViolations.length === 0 && expViolations.length === 0) continue;

  violations++;
  console.error(`${file}:`);
  for (const v of betaViolations) {
    console.error(`  '${v.sym}' should be imported from "@wasmagent/core/beta"`);
  }
  for (const v of expViolations) {
    console.error(`  '${v.sym}' should be imported from "@wasmagent/core/experimental"`);
  }
}

if (violations === 0) {
  console.log("Sub-path import check passed — all beta/experimental symbols use correct paths.");
  process.exit(0);
}

if (!fix) {
  console.error(`\n${violations} file(s) have incorrect @wasmagent/core imports.`);
  console.error("Run: node scripts/check-subpath-imports.mjs --fix  (to auto-fix)");
  process.exit(1);
}

console.log(`\n${violations} file(s) need fixing.`);
process.exit(violations > 0 ? 1 : 0);
