#!/usr/bin/env node
/**
 * Machine-agent instruction truth gate (AGENT-TRUTH-01..05).
 *
 * Coding agents read CLAUDE.md / AGENTS.md as instructions. Stale facts in
 * these files cause automated wrong code placement and duplicated capability
 * — a strictly worse failure mode than stale human docs.
 *
 * Truth sources: this org's canonical ownership map + package metadata
 * (packages/mcp-firewall/package-metadata.json).
 *
 * Checks
 *   AGENT-TRUTH-01  archived repos cannot be named as current owners
 *   AGENT-TRUTH-02  cross-repo schema SSOT must be wasmagent-protocol
 *   AGENT-TRUTH-03  the current AEP family (aep/v0.5) cannot be described as
 *                   a legacy family (v0.1–v0.4) default
 *   AGENT-TRUTH-04  mcp-firewall security phase cannot contradict its
 *                   package-metadata.json (F2 ⇒ no "keyword bag / not
 *                   adversarial-grade" descriptions)
 *   AGENT-TRUTH-05  duplicate "Repository Boundaries" sections fail
 *
 * Exit 0 = clean; 1 = violations.
 */
import { readFileSync } from "node:fs";

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
const EXEMPT_LINE = /archived|HISTORICAL|MIGRATION|superseded/i;

const violations = [];

function scanFile(path, fn) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // optional file
  }
  text.split("\n").forEach((line, i) => {
    const findings = fn(line, text);
    if (findings) {
      for (const f of [].concat(findings)) {
        violations.push(`${path}:${i + 1}: ${f}`);
      }
    }
  });
}

// AGENT-TRUTH-01 — archived repos are never current owners.
scanFile("CLAUDE.md", (line) => {
  if (/agent-trust-infra/i.test(line) && !EXEMPT_LINE.test(line)) {
    return "AGENT-TRUTH-01: 'agent-trust-infra' named without an archived/HISTORICAL marker — it is not a current owner (owners: agentbom, wasmagent-protocol, open-agent-audit)";
  }
  return null;
});
scanFile("AGENTS.md", (line) => {
  if (/agent-trust-infra/i.test(line) && !EXEMPT_LINE.test(line)) {
    return "AGENT-TRUTH-01: 'agent-trust-infra' named without an archived/HISTORICAL marker";
  }
  return null;
});

// AGENT-TRUTH-02 — schema SSOT named positively.
{
  const claude = readFileSync("CLAUDE.md", "utf8");
  if (!/wasmagent-protocol/.test(claude)) {
    violations.push("AGENT-TRUTH-02: CLAUDE.md never names wasmagent-protocol as the cross-repo schema SSOT");
  }
}

// AGENT-TRUTH-03 — the current AEP family is aep/v0.5; legacy families are
// never described as the default/current emission target.
for (const file of INSTRUCTION_FILES) {
  scanFile(file, (line) => {
    if (/aep\/v0\.[1-4]/i.test(line) && /default|current|by default/i.test(line)) {
      return "AGENT-TRUTH-03: legacy AEP family described as default/current — current family is aep/v0.5";
    }
    return null;
  });
}

// AGENT-TRUTH-04 — mcp-firewall phase vs machine metadata.
{
  let phase = null;
  try {
    phase = JSON.parse(readFileSync("packages/mcp-firewall/package-metadata.json", "utf8")).phase ?? null;
  } catch {
    phase = null;
  }
  if (phase === "F2") {
    for (const file of INSTRUCTION_FILES) {
      scanFile(file, (line) => {
        if (/mcp-firewall/i.test(line) && /(keyword bag|not adversarial-grade|not adversarially hardened)/i.test(line)) {
          return "AGENT-TRUTH-04: mcp-firewall described as keyword-bag/not-adversarial while package-metadata declares F2";
        }
        return null;
      });
    }
  }
}

// AGENT-TRUTH-05 — exactly one Repository Boundaries section per file.
for (const file of INSTRUCTION_FILES) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const count = (text.match(/^## Repository Boundaries\s*$/gm) ?? []).length;
  if (count > 1) {
    violations.push(`AGENT-TRUTH-05 ${file}: ${count} '## Repository Boundaries' sections — keep exactly one`);
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`  ::error::${v}`);
  console.error(`agent-truth gate: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log("agent-truth gate: clean");
