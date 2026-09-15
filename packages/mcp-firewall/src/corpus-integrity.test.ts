import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(import.meta.dir, "../evals/corpus");
const SPLIT_FILES = [
  "train.jsonl",
  "dev.jsonl",
  "holdout.jsonl",
  "redteam.jsonl",
  "external.jsonl",
];
const ID_PATTERN = /^fw-attack-\d{6}$/;

function readJsonl(filename: string): unknown[] {
  const raw = readFileSync(join(CORPUS_DIR, filename), "utf-8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function loadAll(): unknown[] {
  const all: unknown[] = [];
  for (const file of SPLIT_FILES) {
    if (existsSync(join(CORPUS_DIR, file))) {
      all.push(...readJsonl(file));
    }
  }
  return all;
}

describe("FW-CORPUS-01: All 5 split files exist", () => {
  for (const file of SPLIT_FILES) {
    it(`${file} exists`, () => {
      expect(existsSync(join(CORPUS_DIR, file))).toBe(true);
    });
  }
});

describe("FW-CORPUS-02: No duplicate IDs across all splits", () => {
  it("all IDs are unique", () => {
    const records = loadAll() as Array<{ id: string }>;
    const ids = records.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe("FW-CORPUS-03: No exact text overlap between train and holdout", () => {
  it("train and holdout share no text values", () => {
    const train = readJsonl("train.jsonl") as Array<{ text: string }>;
    const holdout = readJsonl("holdout.jsonl") as Array<{ text: string }>;
    const trainTexts = new Set(train.map((r) => r.text));
    const overlapping = holdout.filter((r) => trainTexts.has(r.text));
    expect(overlapping).toHaveLength(0);
  });
});

describe("FW-CORPUS-04: Every sample has expected_effect field", () => {
  it("no record is missing expected_effect", () => {
    const records = loadAll() as Array<Record<string, unknown>>;
    const missing = records.filter((r) => !("expected_effect" in r));
    expect(missing).toHaveLength(0);
  });
});

describe("FW-CORPUS-05: Total sample count matches expectation", () => {
  it("train + dev + holdout totals 60", () => {
    const train = readJsonl("train.jsonl");
    const dev = readJsonl("dev.jsonl");
    const holdout = readJsonl("holdout.jsonl");
    expect(train.length + dev.length + holdout.length).toBe(60);
  });
});

describe("FW-CORPUS-06: Every sample ID matches fw-attack-\\d{6} format", () => {
  it("all IDs match the required pattern", () => {
    const records = loadAll() as Array<{ id: string }>;
    const invalid = records.filter((r) => !ID_PATTERN.test(r.id));
    expect(invalid).toHaveLength(0);
  });
});

// ── CORPUS-ADV (P1-05): normalized + near-duplicate leakage checks ───────────
//
// Exact-text checks miss leakage via case/Unicode/whitespace variants and
// paraphrase-grade near-duplicates. Gates (plan §17):
//   train vs holdout: token Jaccard > 0.90 → fail
//   dev   vs holdout: token Jaccard > 0.95 → fail
// Intentional allowlists must be recorded explicitly below, with a reason.

const NEAR_DUP_ALLOWLIST: Array<{ a: string; b: string; reason: string }> = [];

function normalizedText(t: string): string {
  return t.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenSet(t: string): Set<string> {
  return new Set(
    normalizedText(t)
      .split(/[^\w]+/)
      .filter((w) => w.length > 0)
  );
}

function jaccard(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

describe("CORPUS-ADV: normalized + near-duplicate leakage between splits (P1-05)", () => {
  it("CORPUS-ADV-01: no NFKC/case-fold normalized exact duplicates across splits", () => {
    const splits = ["train.jsonl", "dev.jsonl", "holdout.jsonl"] as const;
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const file of splits) {
      for (const r of readJsonl(file) as Array<{ id: string; text: string }>) {
        const key = normalizedText(r.text);
        const prior = seen.get(key);
        if (prior !== undefined) dups.push(`${prior} ↔ ${r.id}`);
        else seen.set(key, r.id);
      }
    }
    expect(dups).toHaveLength(0);
  });

  it("CORPUS-ADV-02: train vs holdout near-duplicate rate within gate (Jaccard ≤ 0.90)", () => {
    const train = readJsonl("train.jsonl") as Array<{ id: string; text: string }>;
    const holdout = readJsonl("holdout.jsonl") as Array<{ id: string; text: string }>;
    const offenders: string[] = [];
    for (const a of train) {
      for (const b of holdout) {
        if (jaccard(a.text, b.text) > 0.9) {
          const allowed = NEAR_DUP_ALLOWLIST.some(
            (w) => (w.a === a.id && w.b === b.id) || (w.a === b.id && w.b === a.id)
          );
          if (!allowed) offenders.push(`${a.id} ↔ ${b.id}`);
        }
      }
    }
    expect(offenders).toHaveLength(0);
  });

  it("CORPUS-ADV-02b: dev vs holdout near-duplicate rate within gate (Jaccard ≤ 0.95)", () => {
    const dev = readJsonl("dev.jsonl") as Array<{ id: string; text: string }>;
    const holdout = readJsonl("holdout.jsonl") as Array<{ id: string; text: string }>;
    const offenders: string[] = [];
    for (const a of dev) {
      for (const b of holdout) {
        if (jaccard(a.text, b.text) > 0.95) {
          const allowed = NEAR_DUP_ALLOWLIST.some(
            (w) => (w.a === a.id && w.b === b.id) || (w.a === b.id && w.b === a.id)
          );
          if (!allowed) offenders.push(`${a.id} ↔ ${b.id}`);
        }
      }
    }
    expect(offenders).toHaveLength(0);
  });
});
