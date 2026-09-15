import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(import.meta.dir, "../evals/corpus");
const SPLIT_FILES = ["train.jsonl", "dev.jsonl", "holdout.jsonl", "redteam.jsonl", "external.jsonl"];
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
