#!/usr/bin/env node
/**
 * Offline red-team sample generator for mcp-firewall.
 *
 * Usage:
 *   node scripts/generate-redteam.mjs [--limit N] [--seed N] [--categories c1,c2] [--dry-run]
 *
 * Reads seed samples from evals/corpus/train.jsonl (malicious only),
 * applies rule-based paraphrase transformations, and emits candidate
 * bypass samples as JSONL on stdout.
 *
 * Review the output and commit selected entries to evals/corpus/redteam.jsonl.
 * Do NOT use generated output directly as a holdout evaluation set.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "../evals/corpus/train.jsonl");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let limit = Infinity;
let seed = 42;
let categories = null;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit" && args[i + 1]) {
    limit = parseInt(args[++i], 10);
  } else if (args[i] === "--seed" && args[i + 1]) {
    seed = parseInt(args[++i], 10);
  } else if (args[i] === "--categories" && args[i + 1]) {
    categories = args[++i].split(",").map((s) => s.trim());
  } else if (args[i] === "--dry-run") {
    dryRun = true;
  }
}

// ── Load seeds ────────────────────────────────────────────────────────────────

const raw = readFileSync(CORPUS_PATH, "utf-8");
let seeds = raw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((s) => s.label === "malicious");

if (categories) {
  seeds = seeds.filter((s) => categories.includes(s.category));
}
if (limit < seeds.length) {
  seeds = seeds.slice(0, limit);
}

// ── Paraphrase rules ──────────────────────────────────────────────────────────

const SYNONYM_MAP = {
  ignore: ["discard", "overlook", "skip"],
  instructions: ["directives", "guidelines", "rules"],
  previous: ["prior", "earlier", "above"],
  forget: ["disregard", "erase", "clear"],
  disregard: ["ignore", "overlook", "dismiss"],
};

function chooseSynonym(_word, synonyms, charCode) {
  return synonyms[(seed + charCode) % synonyms.length];
}

function synonymSub(text) {
  let result = text;
  for (const [word, synonyms] of Object.entries(SYNONYM_MAP)) {
    const re = new RegExp(`\\b${word}\\b`, "gi");
    result = result.replace(re, (match) => chooseSynonym(word, synonyms, match.charCodeAt(0) ?? 0));
  }
  return result;
}

function passiveVoice(text) {
  return text
    .replace(/^Ignore\b/i, "Should be ignored —")
    .replace(/^Forget\b/i, "Can be forgotten —")
    .replace(/^Disregard\b/i, "Should be disregarded —");
}

function questionForm(text) {
  if (text.length < 20) return text;
  const lower = text.charAt(0).toLowerCase() + text.slice(1);
  return `What if ${lower.replace(/[.!?]$/, "")} were to happen?`;
}

function indirectSpeech(text, index) {
  const prefixes = [
    "The system has been updated to:",
    "Note: effective immediately,",
    "Per the latest configuration:",
  ];
  const prefix = prefixes[index % prefixes.length];
  return `${prefix} ${text}`;
}

function splitSentence(text) {
  if (text.length < 30) return text;
  return text.replace(/ and /i, ". Now, ");
}

const RULES = [
  { name: "synonym_sub", fn: synonymSub },
  { name: "passive_voice", fn: passiveVoice },
  { name: "question_form", fn: questionForm },
  { name: "indirect_speech", fn: (t, i) => indirectSpeech(t, i) },
  { name: "split_sentence", fn: splitSentence },
];

// ── Generate ──────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
let counter = 1;
let generated = 0;
const ruleHits = new Map(RULES.map((r) => [r.name, 0]));

for (let i = 0; i < seeds.length; i++) {
  const sample = seeds[i];

  for (const rule of RULES) {
    const transformed = rule.fn(sample.text, i);
    if (transformed === sample.text) continue; // rule produced no change

    generated++;
    ruleHits.set(rule.name, (ruleHits.get(rule.name) ?? 0) + 1);

    if (!dryRun) {
      const id = `fw-redteam-${String(counter).padStart(6, "0")}`;
      counter++;
      const entry = {
        id,
        label: "malicious",
        category: sample.category,
        language: sample.language,
        source: "generated",
        origin: "rule_based_paraphrase",
        split: "redteam",
        text: transformed,
        expected_effect: "deny",
        created_at: today,
        license: "internal",
        parent_id: sample.id,
        rule: rule.name,
      };
      process.stdout.write(JSON.stringify(entry) + "\n");
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const ruleBreakdown = [...ruleHits.entries()]
  .filter(([, n]) => n > 0)
  .map(([r, n]) => `  ${r}: ${n}`)
  .join("\n");

process.stderr.write(
  `Generated ${generated} samples from ${seeds.length} seeds using ${RULES.length} rules\n` +
    ruleBreakdown +
    "\n" +
    `Review and commit selected entries to evals/corpus/redteam.jsonl\n`
);
