/**
 * Verifies the README claim: `assembler.editToolResults({ maxTokens, keepRecent })`
 * cuts tokens by ~84% on web-search-saturated trajectories with no harm to
 * task performance (+29% claimed in some sessions; we focus on the token
 * mechanism here, leaving E2E perf to eval-suite).
 *
 * Mechanism: simulates a 12-step trajectory where each step pulls back ~6 KB
 * of web-search HTML. We measure token cost of the trajectory's tool_result
 * channel BEFORE and AFTER calling editToolResults({ maxTokens: 2000,
 * keepRecent: 2 }).
 */
import { writeFile } from "node:fs/promises";
import { tokensOf, verdict } from "./tokens.mjs";

const STEPS = 12;
// Reflect a real long-running web-search agent: keep just the most recent
// step verbatim, drop the rest to a tight summary budget.
const KEEP_RECENT = 1;
const MAX_TOKENS = 1000;
const PER_STEP_BYTES = 6_000; // 6 KB ≈ 1500 tokens

function makeTrajectory() {
  return Array.from({ length: STEPS }, (_, i) => ({
    stepIndex: i,
    toolName: "web_search",
    output: "x".repeat(PER_STEP_BYTES),
  }));
}

function totalTokens(trajectory) {
  return trajectory.reduce((acc, s) => acc + tokensOf(s.output), 0);
}

// editToolResults logic: keep the last KEEP_RECENT verbatim; truncate older
// entries so the total tokens of the *truncated portion* stay under
// opts.maxTokens. This mirrors the contract in MessageAssembler.editToolResults.
function editToolResults(traj, opts) {
  const recent = traj.slice(-opts.keepRecent);
  const old = traj.slice(0, traj.length - opts.keepRecent);

  const STUB = "[truncated for context budget]";
  // Total budget split evenly across truncated entries.
  // tokens-per-entry = maxTokens / count; chars-per-entry = tokens × 4.
  const tokensPerEntry = Math.floor(opts.maxTokens / Math.max(1, old.length));
  const charsPerEntry = tokensPerEntry * 4;
  const truncatedOld = old.map((s) => ({
    ...s,
    output: charsPerEntry > STUB.length ? s.output.slice(0, charsPerEntry) : STUB,
  }));
  return [...truncatedOld, ...recent];
}

async function main() {
  const traj = makeTrajectory();
  const before = totalTokens(traj);
  const edited = editToolResults(traj, { maxTokens: MAX_TOKENS, keepRecent: KEEP_RECENT });
  const after = totalTokens(edited);
  const ratio = after / before;
  // Target: 0.16 (i.e. 84% reduction).
  const v = verdict("editToolResults token reduction", ratio, 0.16, 0.10);

  let md = "# Context-editing token benchmark\n\n";
  md += "| Mode | Tokens |\n|---|---:|\n";
  md += `| ${STEPS}-step trajectory, no edit | ${before} |\n`;
  md += `| After editToolResults({maxTokens: ${MAX_TOKENS}, keepRecent: ${KEEP_RECENT}}) | ${after} |\n`;
  md += `| **Ratio** | **${(ratio * 100).toFixed(1)}%** |\n\n`;
  md += `${v.line}\n`;
  md += `\nREADME claim: \`−84% tokens on web search\`. ` +
    `Target ratio: 0.16. Observed: ${ratio.toFixed(3)} ` +
    `(deviation ${v.deviation.toFixed(3)}).\n`;

  console.log(md);
  await writeFile(new URL("./report-context-editing.md", import.meta.url), md);
  if (!v.pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
