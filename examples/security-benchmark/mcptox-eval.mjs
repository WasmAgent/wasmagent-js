#!/usr/bin/env node
/**
 * MCPTox-aligned security benchmark for @wasmagent/mcp-firewall.
 *
 * Runs vetTool() + evaluateAdversarial() against a labeled corpus
 * and reports precision, recall, F1, and per-category breakdown.
 *
 * Categories tested (aligned with MCPTox taxonomy, ITECS 2026):
 * - prompt_injection (direct and indirect, multilingual, obfuscated)
 * - exfiltration (data stealing via URLs, env vars, credential files)
 * - invisible_chars (zero-width spaces, homoglyphs)
 * - sampling_abuse (tool descriptions that manipulate LLM sampling)
 * - rug_pull (tools that change behavior after initial use)
 *
 * Usage (from repo root):
 *   bun run build
 *   node examples/security-benchmark/mcptox-eval.mjs
 *
 * Or with report output:
 *   node examples/security-benchmark/mcptox-eval.mjs --report
 */

import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Resolve @wasmagent/mcp-firewall from monorepo dist ─────────────────────

const firewallDist = resolve(__dirname, "../../packages/mcp-firewall/dist/index.js");

let vetTool, evaluateAdversarial;
try {
  const m = await import(firewallDist);
  vetTool = m.vetTool;
  evaluateAdversarial = m.evaluateAdversarial;
} catch {
  try {
    const m = await import("@wasmagent/mcp-firewall");
    vetTool = m.vetTool;
    evaluateAdversarial = m.evaluateAdversarial;
  } catch {
    console.error(
      "ERROR: Could not load @wasmagent/mcp-firewall.\n" +
        "Run `bun run build` from the repo root first, then retry."
    );
    process.exit(1);
  }
}

// ── Load corpus ────────────────────────────────────────────────────────────

const maliciousPath = resolve(__dirname, "corpus/malicious-tools.json");
const benignPath = resolve(__dirname, "corpus/benign-tools.json");

const require_ = createRequire(import.meta.url);
const malicious = require_(maliciousPath);
const benign = require_(benignPath);

// ── Configuration ──────────────────────────────────────────────────────────

const ADVERSARIAL_THRESHOLD = 0.5;

// Classification logic:
// A tool is "flagged" (predicted malicious) if:
//   1. vetTool returns findings with severity "critical" or "high", OR
//   2. evaluateAdversarial on description returns score > ADVERSARIAL_THRESHOLD

function isFlagged(tool) {
  const vettingResult = vetTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });

  const adversarialResult = evaluateAdversarial(tool.description);

  const hasHighSeverity = vettingResult.findings.some(
    (f) => f.severity === "critical" || f.severity === "high"
  );

  const flagged = hasHighSeverity || adversarialResult.score > ADVERSARIAL_THRESHOLD;

  return {
    flagged,
    vettingResult,
    adversarialResult,
    riskScore: Math.max(
      vettingResult.blocked ? 1.0 : vettingResult.findings.length > 0 ? 0.7 : 0.0,
      adversarialResult.score
    ),
  };
}

// ── Run benchmark ──────────────────────────────────────────────────────────

const results = {
  truePositives: [],
  falsePositives: [],
  trueNegatives: [],
  falseNegatives: [],
};

const categoryResults = {};

// Process malicious tools (positives)
for (const tool of malicious) {
  const { flagged, vettingResult, adversarialResult, riskScore } = isFlagged(tool);

  if (!categoryResults[tool.category]) {
    categoryResults[tool.category] = { total: 0, detected: 0, samples: [] };
  }
  categoryResults[tool.category].total++;

  if (flagged) {
    results.truePositives.push({ tool, vettingResult, adversarialResult, riskScore });
    categoryResults[tool.category].detected++;
  } else {
    results.falseNegatives.push({ tool, vettingResult, adversarialResult, riskScore });
  }
  categoryResults[tool.category].samples.push({
    name: tool.name,
    flagged,
    riskScore,
  });
}

// Process benign tools (negatives)
for (const tool of benign) {
  const { flagged, vettingResult, adversarialResult, riskScore } = isFlagged(tool);

  if (flagged) {
    results.falsePositives.push({ tool, vettingResult, adversarialResult, riskScore });
  } else {
    results.trueNegatives.push({ tool, vettingResult, adversarialResult, riskScore });
  }
}

// ── Compute metrics ────────────────────────────────────────────────────────

const tp = results.truePositives.length;
const fp = results.falsePositives.length;
const tn = results.trueNegatives.length;
const fn = results.falseNegatives.length;

const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

// ── Console output ─────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

console.log(`\n${BOLD}MCPTox-aligned Security Benchmark${RESET}`);
console.log(`${GRAY}${"=".repeat(60)}${RESET}`);
console.log(`Corpus: ${malicious.length} malicious + ${benign.length} benign tools`);
console.log(`Adversarial threshold: ${ADVERSARIAL_THRESHOLD}`);
console.log(`${GRAY}${"=".repeat(60)}${RESET}\n`);

console.log(`${BOLD}Overall Metrics:${RESET}`);
console.log(`  Precision:       ${CYAN}${precision.toFixed(4)}${RESET}`);
console.log(`  Recall:          ${CYAN}${recall.toFixed(4)}${RESET}`);
console.log(`  F1:              ${CYAN}${f1.toFixed(4)}${RESET}`);
console.log(`  True Positives:  ${GREEN}${tp}${RESET}`);
console.log(`  False Positives: ${YELLOW}${fp}${RESET}`);
console.log(`  True Negatives:  ${GREEN}${tn}${RESET}`);
console.log(`  False Negatives: ${RED}${fn}${RESET}`);
console.log();

console.log(`${BOLD}Per-Category Breakdown:${RESET}`);
console.log(`  ${"Category".padEnd(20)} ${"Samples".padEnd(10)} ${"Detected".padEnd(10)} Recall`);
console.log(`  ${"-".repeat(55)}`);
for (const [category, data] of Object.entries(categoryResults).sort()) {
  const catRecall = data.total > 0 ? data.detected / data.total : 0;
  const color = catRecall >= 0.9 ? GREEN : catRecall >= 0.7 ? YELLOW : RED;
  console.log(
    `  ${category.padEnd(20)} ${String(data.total).padEnd(10)} ${String(data.detected).padEnd(10)} ${color}${catRecall.toFixed(2)}${RESET}`
  );
}
console.log();

if (results.falseNegatives.length > 0) {
  console.log(`${BOLD}${RED}False Negatives (missed malicious):${RESET}`);
  for (const { tool, vettingResult, adversarialResult } of results.falseNegatives) {
    console.log(
      `  ${RED}MISS${RESET} ${tool.name} [${tool.category}] ` +
        `vetScore=${vettingResult.findings.length > 0 ? "findings" : "clean"} ` +
        `advScore=${adversarialResult.score.toFixed(3)}`
    );
  }
  console.log();
}

if (results.falsePositives.length > 0) {
  console.log(`${BOLD}${YELLOW}False Positives (wrongly flagged benign):${RESET}`);
  for (const { tool, vettingResult, adversarialResult } of results.falsePositives) {
    const findingTypes = vettingResult.findings.map((f) => f.type).join(", ");
    console.log(
      `  ${YELLOW}FP${RESET} ${tool.name} [${tool.category}] ` +
        `findings=[${findingTypes}] advScore=${adversarialResult.score.toFixed(3)}`
    );
  }
  console.log();
}

// ── Generate markdown report ───────────────────────────────────────────────

const writeReport = process.argv.includes("--report");

function generateReport() {
  const date = new Date().toISOString().split("T")[0];
  const version = "@wasmagent/mcp-firewall@1.15.0";

  let md = `# MCPTox-aligned Benchmark Report\n\n`;
  md += `**Date**: ${date}\n`;
  md += `**Version**: ${version}\n`;
  md += `**Corpus**: ${malicious.length} malicious + ${benign.length} benign tools\n`;
  md += `**Adversarial Threshold**: ${ADVERSARIAL_THRESHOLD}\n\n`;

  md += `## Overall Metrics\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Precision | ${precision.toFixed(4)} |\n`;
  md += `| Recall | ${recall.toFixed(4)} |\n`;
  md += `| F1 | ${f1.toFixed(4)} |\n`;
  md += `| True Positives | ${tp} |\n`;
  md += `| False Positives | ${fp} |\n`;
  md += `| True Negatives | ${tn} |\n`;
  md += `| False Negatives | ${fn} |\n\n`;

  md += `## Per-Category Breakdown\n\n`;
  md += `| Category | Samples | Detected | Recall |\n`;
  md += `|----------|---------|----------|--------|\n`;
  for (const [category, data] of Object.entries(categoryResults).sort()) {
    const catRecall = data.total > 0 ? data.detected / data.total : 0;
    md += `| ${category} | ${data.total} | ${data.detected} | ${catRecall.toFixed(4)} |\n`;
  }
  md += `\n`;

  if (results.falseNegatives.length > 0) {
    md += `## False Negatives (missed)\n\n`;
    md += `| Tool | Category | Findings | Adversarial Score |\n`;
    md += `|------|----------|----------|-------------------|\n`;
    for (const { tool, vettingResult, adversarialResult } of results.falseNegatives) {
      const findingCount = vettingResult.findings.length;
      md += `| ${tool.name} | ${tool.category} | ${findingCount} findings | ${adversarialResult.score.toFixed(4)} |\n`;
    }
    md += `\n`;
  }

  if (results.falsePositives.length > 0) {
    md += `## False Positives (wrongly flagged)\n\n`;
    md += `| Tool | Category | Finding Types | Adversarial Score |\n`;
    md += `|------|----------|---------------|-------------------|\n`;
    for (const { tool, vettingResult, adversarialResult } of results.falsePositives) {
      const findingTypes = vettingResult.findings.map((f) => f.type).join(", ") || "n/a";
      md += `| ${tool.name} | ${tool.category} | ${findingTypes} | ${adversarialResult.score.toFixed(4)} |\n`;
    }
    md += `\n`;
  }

  md += `## Methodology\n\n`;
  md += `This benchmark evaluates the static vetting layer of @wasmagent/mcp-firewall\n`;
  md += `against a representative corpus aligned with the MCPTox taxonomy (ITECS 2026).\n\n`;
  md += `**Classification rule**: A tool is flagged as malicious if:\n`;
  md += `1. \`vetTool()\` returns findings with severity "critical" or "high", OR\n`;
  md += `2. \`evaluateAdversarial()\` on the description returns score > ${ADVERSARIAL_THRESHOLD}\n\n`;
  md += `**Attack categories tested**:\n`;
  md += `- \`prompt_injection\`: Direct/indirect injection, multilingual (EN/ZH/RU), obfuscated (base64, homoglyph, URL-encoded)\n`;
  md += `- \`exfiltration\`: Data stealing via URLs, env vars, credential files, webhooks\n`;
  md += `- \`invisible_chars\`: Zero-width spaces (U+200B), ZWNJ/ZWJ (U+200C/U+200D), soft hyphens\n`;
  md += `- \`sampling_abuse\`: Tool descriptions that manipulate LLM sampling/completion\n`;
  md += `- \`rug_pull\`: Tools whose descriptions contain delayed/hidden malicious behavior\n`;

  return { md, date };
}

if (writeReport) {
  const { md, date } = generateReport();
  const reportDir = resolve(__dirname, "../../docs/eval-reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, `mcptox-baseline-${date}.md`);
  writeFileSync(reportPath, md, "utf8");
  console.log(`${GREEN}Report written to: ${reportPath}${RESET}\n`);
}

// ── Summary line ───────────────────────────────────────────────────────────

const statusIcon = f1 >= 0.9 ? GREEN + "PASS" : f1 >= 0.7 ? YELLOW + "WARN" : RED + "FAIL";
console.log(`${BOLD}Status: ${statusIcon}${RESET} (F1=${f1.toFixed(4)})\n`);

// Exit with 0 — benchmark is informational, not a gate
process.exit(0);
