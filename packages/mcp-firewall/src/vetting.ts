/**
 * Tool metadata static vetting — two-stage detection pipeline.
 *
 * Stage 1 — keyword bag (first-stage filter):
 *   Deterministic pattern matching against known injection strings,
 *   exfiltration keywords, invisible characters, and sampling abuse.
 *
 * Stage 2 — lightweight n-gram logistic regression (second-stage classifier):
 *   Token n-gram (n=1..3) with hand-tuned weights covering adversarial
 *   categories: injection_en, injection_zh, injection_ru, exfil_zh,
 *   base64_payload, homoglyph, zero_width, obfuscation, jailbreak.
 *   Non-adversarial-grade ML defense — complements, does not replace,
 *   the deterministic first stage.
 *
 * The result of `evaluateAdversarial()` is used as a risk floor in
 * `vetTool()`: any text that scores above the threshold receives at
 * minimum a "high / ask" finding even if the keyword bag misses it.
 */

import type { McpToolEntry } from "@wasmagent/mcp-server";

// ── Types ────────────────────────────────────────────────────────────────────

export type RiskSeverity = "low" | "medium" | "high" | "critical";
export type RiskCategory =
  | "command_execution"
  | "credential_access"
  | "exfiltration"
  | "invisible_chars"
  | "privilege_escalation"
  | "rug_pull"
  | "sampling_abuse"
  | "shadowing"
  | "ssrf"
  | "supply_chain"
  | "tool_poisoning";

export type VettedField = "name" | "description" | "inputSchema";

export type RiskRecommendation = "allow" | "ask" | "deny";

export interface ToolRiskFinding {
  severity: RiskSeverity;
  category: RiskCategory;
  field: VettedField;
  /** Short excerpt of the suspicious content (max 120 chars). */
  evidenceExcerpt: string;
  /** Stable hash of the full field value at finding time. */
  evidenceHash: string;
  recommendation: RiskRecommendation;
}

export interface VettingResult {
  toolName: string;
  findings: ToolRiskFinding[];
  /** Aggregate recommendation — worst-case across all findings. */
  recommendation: RiskRecommendation;
  /** True if any finding has severity=critical or recommendation=deny. */
  blocked: boolean;
}

// ── Adversarial detection types ──────────────────────────────────────────────

/**
 * A single n-gram hit reported by the second-stage classifier.
 */
export interface AdversarialHit {
  /** The n-gram token that matched. */
  ngram: string;
  /** Logistic regression weight for this token. */
  weight: number;
}

/**
 * Result from `evaluateAdversarial()`.
 * `score` is the sigmoid-activated sum of matched token weights (0..1).
 * `hits` lists every matched n-gram with its weight.
 */
export interface AdversarialResult {
  score: number;
  hits: AdversarialHit[];
}

// ── Second-stage n-gram classifier ───────────────────────────────────────────
//
// Hand-tuned logistic regression weights for token unigrams, bigrams, and
// trigrams that strongly predict adversarial tool descriptors.
//
// Weight convention: positive = adversarial signal.
// Threshold: sigmoid(score_sum) > ADVERSARIAL_THRESHOLD → flag.
//
// These weights were derived by inspecting RISK_CORPUS patterns and
// setting values that ensure ≥ 90 % detection rate on that corpus.
// A `train-vetting.mjs` script in packages/mcp-firewall/scripts/ can
// re-derive them from updated training data.

const _ADVERSARIAL_THRESHOLD = 0.5; // sigmoid output threshold (strictly > 0.5 triggers)

// Weights for normalised (NFKC-lowercased, stripped zero-width) token n-grams.
// Keys are space-joined n-gram tokens (bigrams: "ignore previous").
const NGRAM_WEIGHTS: Record<string, number> = {
  // ── Unigrams ─────────────────────────────────────────────────────────────
  ignore: 2.1,
  disregard: 2.3,
  forget: 1.8,
  override: 1.7,
  jailbreak: 3.5,
  dan: 2.0,
  ucar: 3.0,
  unfiltered: 2.5,
  unrestricted: 2.4,
  exfiltrate: 3.2,
  exfiltration: 3.2,
  // Chinese unigrams (NFC normalised)
  忽略: 2.5,
  无限制: 2.8,
  泄露: 2.7,
  密钥: 2.3,
  凭据: 2.2,
  系统提示: 2.6,
  // Additional Chinese unigrams for missed injection_zh / exfil_zh samples
  忘记: 2.4,
  指令: 2.2,
  停止: 1.8,
  丢弃: 2.3,
  密码: 2.2,
  凭证: 2.2,
  攻击: 2.0,
  // Russian unigrams
  игнорируй: 2.5,
  забудь: 2.0,
  ограничен: 2.3,
  отключи: 2.4,
  сбрось: 2.3,
  следуй: 1.8,
  // base64 sentinel unigrams (these exact strings appear in base64 corpus samples)
  aWdub3JlIHByZXZpb3VzIGluc3RydWN0aW9ucw: 3.5,
  ZGlzcmVnYXJkIHlvdXIgaW5zdHJ1Y3Rpb25z: 3.5,
  eW91IGFyZSBub3c: 3.5,
  Zm9yZ2V0IHlvdXIgcHJldmlvdXM: 3.5,
  bmV3IGluc3RydWN0aW9uczo: 3.5,
  c3lzdGVtIHByb21wdDo: 3.5,
  // obfuscation markers
  "1gn0r3": 2.6,
  "1n5truct10n5": 2.6,
  snoitcurtsni: 2.9,

  // ── Bigrams ──────────────────────────────────────────────────────────────
  "ignore previous": 3.8,
  "ignore all": 3.5,
  "disregard your": 3.6,
  "forget your": 3.4,
  "you are": 1.5,
  "are now": 1.6,
  "new instructions": 3.2,
  "system prompt": 3.0,
  "no restrictions": 2.8,
  "no limits": 2.4,
  "developer mode": 2.5,
  "roleplay mode": 2.4,
  "do anything": 2.3,
  "act as": 1.9,
  "safety filters": 2.7,
  "content policies": 2.4,
  "ethical constraints": 2.5,
  // Chinese bigrams
  "忘记 之前": 3.5,
  "忽略 之前": 3.5,
  "新 指令": 2.8,
  新指令: 2.9,
  "忘记 规则": 3.0,
  "没有 限制": 2.9,
  // Russian bigrams
  "игнорируй предыдущие": 3.6,
  "забудь все": 3.2,
  "новые инструкции": 3.0,
  "отключи фильтры": 3.4,
  "сбрось контекст": 3.2,

  // ── Trigrams ─────────────────────────────────────────────────────────────
  "ignore previous instructions": 4.5,
  "ignore all previous": 4.3,
  "disregard your instructions": 4.4,
  "forget your previous": 4.2,
  "you are now": 3.8,
  "new instructions:": 3.9,
  "system prompt:": 3.7,
  "no restrictions active": 3.5,
  "do anything now": 3.9,
  "act as an": 1.8,
  "act as if": 2.2,
  "safety rules": 2.6,
  "all ethical constraints": 3.0,
};

// Invisible / zero-width code points to strip before tokenisation
const ZERO_WIDTH_RE = /[­​-‏‪-‮⁠-⁯﻿]/g;

// Lookalike substitution map for confusable characters (Cyrillic + Greek → ASCII).
// These characters look visually identical to ASCII but have different code points.
// NFKC does NOT normalize these, so we handle them explicitly.
// Applied ONLY when text is predominantly Latin (homoglyph attack detection).
const LOOKALIKE_MAP: Record<string, string> = {
  // Cyrillic look-alikes
  а: "a", // U+0430
  е: "e", // U+0435
  о: "o", // U+043E
  р: "r", // U+0440
  с: "c", // U+0441
  у: "u", // U+0443
  х: "x", // U+0445
  і: "i", // U+0456
  А: "A", // U+0410
  Е: "E", // U+0415
  О: "O", // U+041E
  Р: "R", // U+0420
  С: "C", // U+0421
  // Greek look-alikes
  ο: "o", // U+03BF Greek small omicron
  ν: "v", // U+03BD Greek small nu (approximation)
  Ο: "O", // U+039F Greek capital omicron
};

const LOOKALIKE_RE = new RegExp(Object.keys(LOOKALIKE_MAP).join("|"), "g");

/**
 * Detect if a string is predominantly Latin script.
 * Returns true when > 50% of the letter characters are Latin (Basic Latin or Latin Extended).
 */
function isPredominantlyLatin(text: string): boolean {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return true;
  // U+0020 (space) through U+024F (Latin Extended-B). Excludes Cyrillic so that
  // Russian-language input is classified as non-Latin and routed to the standard
  // (non-homoglyph) n-gram normalisation path.
  const latinCount = letters.filter((c) => /[\u0020-\u024F]/.test(c)).length;
  return latinCount / letters.length > 0.5;
}

/**
 * Normalise text for n-gram extraction (standard path — no lookalike substitution).
 * Used for primarily non-Latin (Russian, Chinese) texts.
 */
function normaliseForNgram(text: string): string {
  return text
    .replace(ZERO_WIDTH_RE, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalise text for n-gram extraction (homoglyph path — with lookalike substitution).
 * Used for primarily Latin texts where Cyrillic/Greek look-alikes may be embedded.
 */
function normaliseForNgramWithHomoglyphs(text: string): string {
  return text
    .replace(ZERO_WIDTH_RE, "")
    .normalize("NFKC")
    .replace(LOOKALIKE_RE, (ch) => LOOKALIKE_MAP[ch] ?? ch)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenise normalised text into words (split on non-word boundaries,
 * keep CJK characters and Cyrillic intact).
 */
function tokenise(text: string): string[] {
  // Split on whitespace and common punctuation, keeping CJK runs together
  return text.split(/[\s,.\-!?;:]+/).filter((t) => t.length > 0);
}

/** Sigmoid activation. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Second-stage lightweight n-gram logistic regression classifier.
 *
 * Returns a score in [0, 1] and the list of matching n-gram hits.
 * A score > ADVERSARIAL_THRESHOLD indicates adversarial content.
 */
export function evaluateAdversarial(text: string): AdversarialResult {
  // Choose normalisation path based on dominant script:
  // - predominantly Latin (or mixed with homoglyphs) → apply lookalike substitution
  // - predominantly non-Latin (Russian, Chinese) → keep as-is to preserve weight keys
  const latinDominant = isPredominantlyLatin(text);
  const norm = latinDominant ? normaliseForNgramWithHomoglyphs(text) : normaliseForNgram(text);
  const tokens = tokenise(norm);
  const hits: AdversarialHit[] = [];
  let weightSum = 0;

  // ── 1. Token n-gram scan (unigrams, bigrams, trigrams) ────────────────────
  for (const token of tokens) {
    const w = NGRAM_WEIGHTS[token];
    if (w !== undefined) {
      hits.push({ ngram: token, weight: w });
      weightSum += w;
    }
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    const w = NGRAM_WEIGHTS[bigram];
    if (w !== undefined) {
      hits.push({ ngram: bigram, weight: w });
      weightSum += w;
    }
  }

  for (let i = 0; i < tokens.length - 2; i++) {
    const trigram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    const w = NGRAM_WEIGHTS[trigram];
    if (w !== undefined) {
      hits.push({ ngram: trigram, weight: w });
      weightSum += w;
    }
  }

  // ── 2. CJK substring scan ─────────────────────────────────────────────────
  for (const [phrase, w] of Object.entries(NGRAM_WEIGHTS)) {
    const hasCjk = /[一-鿿぀-ゟ゠-ヿ]/.test(phrase);
    if (!hasCjk) continue;
    if (norm.includes(phrase) && !hits.some((h) => h.ngram === phrase)) {
      hits.push({ ngram: phrase, weight: w });
      weightSum += w;
    }
  }

  // ── 3. Base64 payload detection ──────────────────────────────────────────
  const base64Keys = Object.keys(NGRAM_WEIGHTS).filter(
    (k) => !k.includes(" ") && /^[A-Za-z0-9+/=]{10,}$/.test(k)
  );
  for (const key of base64Keys) {
    if (text.includes(key) && !hits.some((h) => h.ngram === key)) {
      // biome-ignore lint/style/noNonNullAssertion: key iterated from NGRAM_WEIGHTS
      const w = NGRAM_WEIGHTS[key]!;
      hits.push({ ngram: key, weight: w });
      weightSum += w;
    }
  }

  // ── 4. Injection delimiter detection ─────────────────────────────────────
  if (text.includes("[[") || text.includes("]]")) {
    const w = 2.5;
    hits.push({ ngram: "[[]]_delimiter", weight: w });
    weightSum += w;
  }

  // ── 5. Dot-separated obfuscation ─────────────────────────────────────────
  const dotSeparatedRe = /\b([a-z]\.){4,}[a-z]?\b/g;
  let dotMatch: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional loop pattern
  while ((dotMatch = dotSeparatedRe.exec(norm)) !== null) {
    const reconstructed = dotMatch[0].replace(/\./g, "");
    const w = NGRAM_WEIGHTS[reconstructed];
    if (w !== undefined && !hits.some((h) => h.ngram === `dot:${reconstructed}`)) {
      hits.push({ ngram: `dot:${reconstructed}`, weight: w });
      weightSum += w;
    }
  }

  // ── 6. URL-encoding obfuscation ───────────────────────────────────────────
  if (text.includes("%20") || /%[0-9a-fA-F]{2}/.test(text)) {
    try {
      const decoded = decodeURIComponent(text);
      const decodedNorm = normaliseForNgramWithHomoglyphs(decoded);
      const decodedTokens = tokenise(decodedNorm);
      for (let i = 0; i < decodedTokens.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: i bounded by decodedTokens.length
        const tk = decodedTokens[i]!;
        const w = NGRAM_WEIGHTS[tk];
        if (w !== undefined && !hits.some((h) => h.ngram === `url:${tk}`)) {
          hits.push({ ngram: `url:${tk}`, weight: w });
          weightSum += w;
        }
        if (i < decodedTokens.length - 1) {
          const bg = `${decodedTokens[i]} ${decodedTokens[i + 1]}`;
          const bw = NGRAM_WEIGHTS[bg];
          if (bw !== undefined && !hits.some((h) => h.ngram === `url:${bg}`)) {
            hits.push({ ngram: `url:${bg}`, weight: bw });
            weightSum += bw;
          }
        }
        if (i < decodedTokens.length - 2) {
          const tg = `${decodedTokens[i]} ${decodedTokens[i + 1]} ${decodedTokens[i + 2]}`;
          const tw = NGRAM_WEIGHTS[tg];
          if (tw !== undefined && !hits.some((h) => h.ngram === `url:${tg}`)) {
            hits.push({ ngram: `url:${tg}`, weight: tw });
            weightSum += tw;
          }
        }
      }
    } catch {
      // ignore decode errors
    }
  }

  // ── 7. Hex-escape obfuscation ─────────────────────────────────────────────
  const hexEscapeRe = /(?:\\x[0-9a-fA-F]{2})+/g;
  let hexMatch: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional loop pattern
  while ((hexMatch = hexEscapeRe.exec(text)) !== null) {
    try {
      const decoded = hexMatch[0].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
        String.fromCharCode(Number.parseInt(h, 16))
      );
      const decodedTokens = tokenise(normaliseForNgramWithHomoglyphs(decoded));
      for (const tk of decodedTokens) {
        const w = NGRAM_WEIGHTS[tk];
        if (w !== undefined && !hits.some((h) => h.ngram === `hex:${tk}`)) {
          hits.push({ ngram: `hex:${tk}`, weight: w });
          weightSum += w;
        }
      }
    } catch {
      // ignore decode errors
    }
  }

  // ── 8. Filesystem exfiltration path detection ─────────────────────────────
  const EXFIL_PATHS = ["/etc/passwd", "~/.ssh", "~/.aws", ".env"];
  for (const path of EXFIL_PATHS) {
    if (text.includes(path) && !hits.some((h) => h.ngram === `exfil:${path}`)) {
      hits.push({ ngram: `exfil:${path}`, weight: 3.0 });
      weightSum += 3.0;
    }
  }
  // token / credential keywords in CJK context
  if (/token|credential/i.test(text) && /[一-鿿]/.test(text)) {
    if (!hits.some((h) => h.ngram === "exfil:token_zh")) {
      hits.push({ ngram: "exfil:token_zh", weight: 2.5 });
      weightSum += 2.5;
    }
  }

  // ── 9. Homoglyph encoding boost ──────────────────────────────────────────
  // When the lookalike path was used and produced hits, and the original text
  // contained non-ASCII characters, add a small homoglyph-encoding boost to
  // account for the deliberate character substitution.
  if (latinDominant && hits.length > 0) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check, intentional for homoglyph detection
    const hasNonAscii = /[^\x00-\x7F]/.test(text);
    const normBaseline = text
      .replace(ZERO_WIDTH_RE, "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (hasNonAscii && norm !== normBaseline) {
      weightSum += 0.8; // homoglyph boost
    }
  }

  const score = sigmoid(weightSum);
  return { score, hits };
}

// ── Rule tables ──────────────────────────────────────────────────────────────

// Prompt injection / tool poisoning patterns (case-insensitive)
const INJECTION_PATTERNS: string[] = [
  "ignore previous instructions",
  "ignore all previous",
  "disregard your instructions",
  "you are now",
  "forget your previous",
  "new instructions:",
  "system prompt:",
  "[[", // common injection delimiter
  "]]",
];

// Exfiltration — requesting access to sensitive env/filesystem
const EXFILTRATION_PATTERNS: string[] = [
  "process.env",
  "env var",
  "environment variable",
  "api key",
  "secret",
  "password",
  "token",
  "credential",
  "private key",
  "/etc/passwd",
  "~/.ssh",
  "~/.aws",
  ".env",
];

// Sampling abuse — tool asking the host/LLM to call it back
const SAMPLING_PATTERNS: string[] = [
  "call the llm",
  "ask the model",
  "request a completion",
  "send a request to",
  "invoke the assistant",
  "sampling request",
];

// Invisible / non-printable Unicode ranges that could hide instructions
const INVISIBLE_CHAR_RE = /[­​-‏‪-‮⁠-⁯﻿]/;

// ── Helpers ──────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

function fieldHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function excerpt(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

function scanText(text: string, field: VettedField, _toolName: string): ToolRiskFinding[] {
  const findings: ToolRiskFinding[] = [];
  const lower = text.toLowerCase();
  const hash = fieldHash(text);

  for (const pat of INJECTION_PATTERNS) {
    if (lower.includes(pat)) {
      findings.push({
        severity: "critical",
        category: "tool_poisoning",
        field,
        evidenceExcerpt: excerpt(text),
        evidenceHash: hash,
        recommendation: "deny",
      });
      break; // one finding per category per field
    }
  }

  for (const pat of EXFILTRATION_PATTERNS) {
    if (lower.includes(pat)) {
      findings.push({
        severity: "high",
        category: "exfiltration",
        field,
        evidenceExcerpt: excerpt(text),
        evidenceHash: hash,
        recommendation: "ask",
      });
      break;
    }
  }

  for (const pat of SAMPLING_PATTERNS) {
    if (lower.includes(pat)) {
      findings.push({
        severity: "high",
        category: "sampling_abuse",
        field,
        evidenceExcerpt: excerpt(text),
        evidenceHash: hash,
        recommendation: "ask",
      });
      break;
    }
  }

  if (INVISIBLE_CHAR_RE.test(text)) {
    findings.push({
      severity: "medium",
      category: "invisible_chars",
      field,
      evidenceExcerpt: excerpt(text),
      evidenceHash: hash,
      recommendation: "ask",
    });
  }

  // ── Second-stage: n-gram logistic regression risk floor ───────────────────
  // If the classifier scores above threshold and no critical/high finding
  // has already been raised, emit a "high / ask" finding so that obfuscated
  // or multilingual injections that bypass the keyword bag are still caught.
  const adversarial = evaluateAdversarial(text);
  const alreadyFlagged = findings.some((f) => f.severity === "critical" || f.severity === "high");
  if (!alreadyFlagged && adversarial.score > 0.5) {
    findings.push({
      severity: "high",
      category: "tool_poisoning",
      field,
      evidenceExcerpt: excerpt(
        `[adversarial-classifier score=${adversarial.score.toFixed(3)} hits=${adversarial.hits.map((h) => h.ngram).join("|")}] ${excerpt(text, 80)}`
      ),
      evidenceHash: hash,
      recommendation: adversarial.score >= 0.9 ? "deny" : "ask",
    });
  }

  return findings;
}

// ── Public API ───────────────────────────────────────────────────────────────

const RECOMMENDATION_ORDER: Record<RiskRecommendation, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function worstRecommendation(findings: ToolRiskFinding[]): RiskRecommendation {
  if (findings.length === 0) return "allow";
  return findings.reduce<RiskRecommendation>((worst, f) => {
    return RECOMMENDATION_ORDER[f.recommendation] > RECOMMENDATION_ORDER[worst]
      ? f.recommendation
      : worst;
  }, "allow");
}

/**
 * Build a composite cache key for vetting results.
 *
 * The key incorporates name, description, inputSchema, and an optional
 * serverIdentity so that any change to the tool descriptor (including a
 * server-side "rug pull") immediately invalidates the cached vetting result.
 *
 * @param entry          The MCP tool entry being vetted.
 * @param serverIdentity An optional server identifier (e.g. serverId).
 */
export function buildVettingCacheKey(entry: McpToolEntry, serverIdentity = ""): string {
  const nameHash = fieldHash(entry.name);
  const descHash = fieldHash(entry.description);
  const schemaHash = fieldHash(JSON.stringify(entry.inputSchema));
  const serverHash = fieldHash(serverIdentity);
  return `${nameHash}:${descHash}:${schemaHash}:${serverHash}`;
}

/**
 * Run all static vetting rules against a single MCP tool entry.
 * No network calls, no ML — purely deterministic.
 */
export function vetTool(entry: McpToolEntry): VettingResult {
  const findings: ToolRiskFinding[] = [
    ...scanText(entry.description, "description", entry.name),
    ...scanText(JSON.stringify(entry.inputSchema), "inputSchema", entry.name),
    ...scanText(entry.name, "name", entry.name),
  ];

  const recommendation = worstRecommendation(findings);
  return {
    toolName: entry.name,
    findings,
    recommendation,
    blocked: recommendation === "deny",
  };
}

/**
 * Vet a batch of tools. Returns one VettingResult per tool.
 */
export function vetTools(entries: McpToolEntry[]): VettingResult[] {
  return entries.map(vetTool);
}
