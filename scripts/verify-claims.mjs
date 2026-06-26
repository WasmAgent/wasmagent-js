#!/usr/bin/env node
/**
 * verify-claims.mjs — validate the docs/claims/claims.yaml registry.
 *
 * Usage:
 *   node scripts/verify-claims.mjs           # check mode
 *   node scripts/verify-claims.mjs --strict  # warnings become errors
 *   node scripts/verify-claims.mjs --list    # print claim table
 *   node scripts/verify-claims.mjs --update  # stamp today on per-pr claims
 *   node scripts/verify-claims.mjs --html    # write HTML dashboard to docs/claims/claims.html
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const CLAIMS_FILE = resolve(ROOT, "docs/claims/claims.yaml");
const DOCS_DIR = resolve(ROOT, "docs");
const README_FILE = resolve(ROOT, "README.md");

/** Recursively collect all .md files under a directory. */
function collectMarkdownFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const LIST = args.includes("--list");
const UPDATE = args.includes("--update");
const HTML = args.includes("--html");

const VALID_CI_MODES = ["nightly", "manual", "per-pr"];

// Staleness thresholds in days per ci_mode
const STALE_DAYS = {
  nightly: 14,
  "per-pr": 7,
  manual: 90,
};

// ─── YAML parser (manual, no dependencies) ─────────────────────────────────

/**
 * Parse the claims YAML file. The format is a simple YAML list where each
 * entry starts with `- id:`. Fields are indented with two spaces.
 *
 * Returns an array of plain objects.
 */
function parseClaims(text) {
  const claims = [];

  // Split into blocks on lines that start a new list item (`- id:`)
  // We keep the delimiter by using a lookahead-style split approach.
  const lines = text.split("\n");
  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (/^- id:/.test(line)) {
      if (current !== null) blocks.push(current);
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) blocks.push(current);

  for (const block of blocks) {
    const obj = {};
    let i = 0;

    // First line: `- id: value`
    const firstLine = block[0];
    const idMatch = firstLine.match(/^- id:\s*(.+)/);
    if (idMatch) obj.id = idMatch[1].trim();

    i = 1;
    while (i < block.length) {
      const line = block[i];

      // Skip comment lines and blank lines
      if (/^\s*#/.test(line) || line.trim() === "") {
        i++;
        continue;
      }

      // Match a field line: `  key: value`
      const fieldMatch = line.match(/^ {2}(\w[\w_-]*):\s*(.*)/);
      if (!fieldMatch) {
        i++;
        continue;
      }

      const key = fieldMatch[1];
      let value = fieldMatch[2].trim();

      // Block scalar (>) — collect continuation lines
      if (value === ">") {
        const parts = [];
        i++;
        while (i < block.length) {
          const cont = block[i];
          // Continuation lines are indented with >= 4 spaces
          if (
            /^ {4}/.test(cont) ||
            (cont.trim() === "" && i + 1 < block.length && /^ {4}/.test(block[i + 1]))
          ) {
            parts.push(cont.trim());
            i++;
          } else {
            break;
          }
        }
        obj[key] = parts.join(" ").trim();
        continue;
      }

      // Quoted string — strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      obj[key] = value;
      i++;
    }

    claims.push(obj);
  }

  return claims;
}

// ─── Validation helpers ─────────────────────────────────────────────────────

function isValidISODate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str);
  return !Number.isNaN(d.getTime());
}

function daysSince(dateStr) {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ─── README / docs numeric-claim cross-check ───────────────────────────────

/**
 * Extract numeric tokens from README that look like performance claims.
 * Examples: "22%", "50ms", "37%", "3.1%", "13.6%"
 */
function extractReadmeNumerics(text) {
  const found = new Set();
  const re = /\b(\d+(?:\.\d+)?)(ms|%)/g;
  for (const m of text.matchAll(re)) {
    found.add(m[1] + m[2]);
  }
  return found;
}

/**
 * Check if a given numeric token is referenced by any claim's text fields.
 */
function claimReferencesNumeric(claim, numeric) {
  const searchIn = [claim.claim ?? "", claim.notes ?? ""].join(" ");
  return searchIn.includes(numeric);
}

// ─── HTML report ────────────────────────────────────────────────────────────

/**
 * Return the HTML status label and CSS class for a claim based on days since
 * last_verified.  Uses a fixed 30 / 90 day threshold regardless of ci_mode so
 * the dashboard gives a human-friendly at-a-glance view.
 */
function claimHtmlStatus(claim) {
  if (!claim.last_verified || !isValidISODate(claim.last_verified)) {
    return { label: "✗ Outdated", cls: "status-outdated" };
  }
  const age = daysSince(claim.last_verified);
  if (age <= 30) return { label: "✓ Verified", cls: "status-verified" };
  if (age <= 90) return { label: "⚠ Stale", cls: "status-stale" };
  return { label: "✗ Outdated", cls: "status-outdated" };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateHtmlReport(claims, rootDir) {
  let verified = 0;
  let stale = 0;
  let outdated = 0;

  const rows = claims
    .map((c) => {
      const { label, cls } = claimHtmlStatus(c);
      if (cls === "status-verified") verified++;
      else if (cls === "status-stale") stale++;
      else outdated++;

      const scriptRel = escapeHtml(c.evidence_script ?? "");
      const scriptPath = c.evidence_script ? resolve(rootDir, c.evidence_script) : null;
      const scriptExists = scriptPath ? existsSync(scriptPath) : false;
      const scriptCell = scriptExists
        ? `<a href="${scriptRel}" style="color:#7ec8e3;">${scriptRel}</a>`
        : `<span style="color:#e07070;">${scriptRel}</span>`;

      return `    <tr>
      <td><code>${escapeHtml(c.id)}</code></td>
      <td>${escapeHtml(c.claim)}</td>
      <td>${scriptCell}</td>
      <td>${escapeHtml(c.last_verified)}</td>
      <td><span class="badge badge-${escapeHtml(c.ci_mode ?? "")}">${escapeHtml(c.ci_mode)}</span></td>
      <td><span class="${cls}">${label}</span></td>
    </tr>`;
    })
    .join("\n");

  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WasmAgent — Claim Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f1117;
      color: #d0d4de;
      font-family: ui-monospace, "Cascadia Code", "Fira Mono", monospace;
      font-size: 13px;
      padding: 32px 24px;
    }
    h1 { color: #e8eaf0; font-size: 20px; margin-bottom: 6px; }
    .meta { color: #6b7280; font-size: 12px; margin-bottom: 20px; }
    .summary {
      display: flex; gap: 20px; margin-bottom: 24px; flex-wrap: wrap;
    }
    .summary-card {
      background: #1a1d27;
      border: 1px solid #2a2d3a;
      border-radius: 6px;
      padding: 10px 18px;
      min-width: 120px;
    }
    .summary-card .num { font-size: 24px; font-weight: bold; }
    .summary-card .lbl { color: #6b7280; font-size: 11px; margin-top: 2px; }
    .num-total   { color: #a0a8c0; }
    .num-verified { color: #4ade80; }
    .num-stale   { color: #facc15; }
    .num-outdated { color: #f87171; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #13161f;
      border-radius: 8px;
      overflow: hidden;
    }
    thead tr { background: #1e2230; }
    th {
      text-align: left;
      padding: 10px 14px;
      color: #8892a4;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid #2a2d3a;
    }
    td {
      padding: 9px 14px;
      border-bottom: 1px solid #1e2230;
      vertical-align: top;
      line-height: 1.45;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #191c28; }
    td:first-child code {
      background: #1e2230;
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 12px;
      color: #9ab5f5;
    }
    .badge {
      display: inline-block;
      border-radius: 3px;
      padding: 1px 7px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
    }
    .badge-nightly  { background: #1e3a5f; color: #7ec8e3; }
    .badge-per-pr   { background: #1e3a2f; color: #6de0a0; }
    .badge-manual   { background: #3a2e1e; color: #e0b96d; }
    .status-verified { color: #4ade80; font-weight: 600; }
    .status-stale    { color: #facc15; font-weight: 600; }
    .status-outdated { color: #f87171; font-weight: 600; }
  </style>
</head>
<body>
  <h1>WasmAgent — Claim Dashboard</h1>
  <p class="meta">Generated: ${now} &nbsp;|&nbsp; Source: docs/claims/claims.yaml</p>

  <div class="summary">
    <div class="summary-card">
      <div class="num num-total">${claims.length}</div>
      <div class="lbl">total claims</div>
    </div>
    <div class="summary-card">
      <div class="num num-verified">${verified}</div>
      <div class="lbl">verified (&le;30d)</div>
    </div>
    <div class="summary-card">
      <div class="num num-stale">${stale}</div>
      <div class="lbl">stale (31–90d)</div>
    </div>
    <div class="summary-card">
      <div class="num num-outdated">${outdated}</div>
      <div class="lbl">outdated (&gt;90d)</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Claim</th>
        <th>Evidence Script</th>
        <th>Last Verified</th>
        <th>CI Mode</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

// ─── --update mode ─────────────────────────────────────────────────────────

function updatePerPrClaims(rawText, claims, today) {
  let updated = rawText;
  let count = 0;
  for (const claim of claims) {
    if (claim.ci_mode !== "per-pr") continue;
    // Replace the last_verified line for this claim's id block
    // Strategy: replace `last_verified: "YYYY-MM-DD"` that follows `id: <id>`
    const escapedId = claim.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(- id:\\s*${escapedId}[\\s\\S]*?  last_verified:\\s*)"[^"]*"`);
    const replacement = `$1"${today}"`;
    const before = updated;
    updated = updated.replace(re, replacement);
    if (updated !== before) count++;
  }
  return { updated, count };
}

// ─── Main ───────────────────────────────────────────────────────────────────

const errors = [];
const warnings = [];

// Read and parse claims
let rawYaml;
try {
  rawYaml = readFileSync(CLAIMS_FILE, "utf8");
} catch (e) {
  console.error(`ERROR: Cannot read ${CLAIMS_FILE}: ${e.message}`);
  process.exit(1);
}

const claims = parseClaims(rawYaml);

if (claims.length === 0) {
  console.error("ERROR: No claims parsed from claims.yaml — check file format.");
  process.exit(1);
}

// ── --update mode ──────────────────────────────────────────────────────────
if (UPDATE) {
  const today = todayISO();
  const { updated, count } = updatePerPrClaims(rawYaml, claims, today);
  if (count > 0) {
    writeFileSync(CLAIMS_FILE, updated, "utf8");
    console.log(`Updated last_verified to ${today} for ${count} per-pr claim(s).`);
  } else {
    console.log("No per-pr claims to update (or none needed updating).");
  }
  process.exit(0);
}

// ── --list mode ─────────────────────────────────────────────────────────────
if (LIST) {
  const colWidths = { id: 38, ci_mode: 8, last_verified: 13, claim: 60 };
  const pad = (s, n) =>
    String(s ?? "")
      .slice(0, n)
      .padEnd(n);
  const header =
    pad("ID", colWidths.id) +
    "  " +
    pad("CI_MODE", colWidths.ci_mode) +
    "  " +
    pad("LAST_VERIFIED", colWidths.last_verified) +
    "  " +
    "CLAIM";
  const sep = "-".repeat(header.length);
  console.log(sep);
  console.log(header);
  console.log(sep);
  for (const c of claims) {
    console.log(
      pad(c.id, colWidths.id) +
        "  " +
        pad(c.ci_mode, colWidths.ci_mode) +
        "  " +
        pad(c.last_verified, colWidths.last_verified) +
        "  " +
        String(c.claim ?? "").slice(0, colWidths.claim)
    );
  }
  console.log(sep);
  console.log(`${claims.length} claim(s) total.`);
  process.exit(0);
}

// ── --html mode ─────────────────────────────────────────────────────────────
if (HTML) {
  const html = generateHtmlReport(claims, ROOT);
  const outPath = resolve(ROOT, "docs/claims/claims.html");
  writeFileSync(outPath, html);
  console.log("Claims dashboard written to", outPath);
  process.exit(0);
}

// ── Structural validation ────────────────────────────────────────────────────

const seenIds = new Set();
const REQUIRED_FIELDS = ["id", "claim", "evidence_script", "last_verified", "ci_mode"];

for (const claim of claims) {
  const label = claim.id ? `[${claim.id}]` : `[claim at index ${claims.indexOf(claim)}]`;

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!claim[field]) {
      errors.push(`${label}: missing required field '${field}'`);
    }
  }

  // Unique IDs
  if (claim.id) {
    if (seenIds.has(claim.id)) {
      errors.push(`Duplicate claim id: '${claim.id}'`);
    }
    seenIds.add(claim.id);
  }

  // ISO date format
  if (claim.last_verified && !isValidISODate(claim.last_verified)) {
    errors.push(`${label}: last_verified '${claim.last_verified}' is not a valid YYYY-MM-DD date`);
  }

  // ci_mode values
  if (claim.ci_mode && !VALID_CI_MODES.includes(claim.ci_mode)) {
    errors.push(
      `${label}: ci_mode '${claim.ci_mode}' is invalid — must be one of: ${VALID_CI_MODES.join(", ")}`
    );
  }

  // evidence_script existence
  if (claim.evidence_script) {
    const scriptPath = resolve(ROOT, claim.evidence_script);
    if (!existsSync(scriptPath)) {
      errors.push(`${label}: evidence_script '${claim.evidence_script}' does not exist on disk`);
    }
  }

  // Staleness check
  if (claim.last_verified && isValidISODate(claim.last_verified) && claim.ci_mode) {
    const maxDays = STALE_DAYS[claim.ci_mode];
    if (maxDays !== undefined) {
      const age = daysSince(claim.last_verified);
      if (age > maxDays) {
        warnings.push(
          `${label}: last_verified is ${age} day(s) old (ci_mode='${claim.ci_mode}', threshold=${maxDays}d) — re-verify and update last_verified`
        );
      }
    }
  }
}

// ── Docs numeric cross-check (README + all docs/**/*.md) ─────────────────────

const NUMERIC_ALLOWLIST = new Set(["0%", "0.0%", "100%", "100.0%", "50%", "0ms", "1ms"]);

const docsToScan = [];
if (existsSync(README_FILE)) docsToScan.push(README_FILE);
if (existsSync(DOCS_DIR)) docsToScan.push(...collectMarkdownFiles(DOCS_DIR));

if (docsToScan.length === 0) {
  warnings.push("No markdown files found — skipping numeric-claim cross-check");
}

const allNumerics = new Map();
for (const docPath of docsToScan) {
  let text = "";
  try {
    text = readFileSync(docPath, "utf8");
  } catch {
    continue;
  }
  const relPath = docPath.replace(ROOT + "/", "");
  if (relPath.startsWith("docs/claims/")) continue;
  const numerics = extractReadmeNumerics(text);
  for (const num of numerics) {
    if (!allNumerics.has(num)) allNumerics.set(num, new Set());
    allNumerics.get(num).add(relPath);
  }
}

const scannedCount = docsToScan.length;
for (const [num, files] of allNumerics) {
  if (NUMERIC_ALLOWLIST.has(num)) continue;
  const covered = claims.some((c) => claimReferencesNumeric(c, num));
  if (!covered) {
    const locations = [...files].join(", ");
    warnings.push(
      `Docs mention '${num}' (in: ${locations}) but no claim entry references it — add a claim or update an existing one`
    );
  }
}

// ── Output summary ───────────────────────────────────────────────────────────

const effectiveErrors = STRICT ? [...errors, ...warnings] : errors;

console.log(`\nClaim registry: ${CLAIMS_FILE}`);
console.log(`Claims parsed : ${claims.length}`);
console.log(`Docs scanned  : ${scannedCount} markdown files (README + docs/**/*.md)`);
console.log(`Errors        : ${errors.length}`);
console.log(
  `Warnings      : ${warnings.length}${STRICT ? " (treated as errors in --strict mode)" : ""}`
);
console.log();

if (errors.length > 0) {
  console.error("ERRORS:");
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.log();
}

if (warnings.length > 0) {
  const prefix = STRICT ? "  ✗" : "  ⚠";
  console.log(STRICT ? "WARNINGS (--strict → errors):" : "WARNINGS:");
  for (const w of warnings) console.log(`${prefix} ${w}`);
  console.log();
}

if (effectiveErrors.length === 0) {
  console.log(`All ${claims.length} claim(s) passed validation.`);
  process.exit(0);
} else {
  console.error(`Validation FAILED with ${effectiveErrors.length} error(s).`);
  process.exit(1);
}
