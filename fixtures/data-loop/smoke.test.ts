/**
 * Data-loop fixture smoke test — validates the fixture JSONL against the
 * rollout-wire schema and confirms the fixture matches manifest expectations.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(import.meta.dir);

function readJsonl(filename: string): unknown[] {
  const raw = readFileSync(join(FIXTURE_DIR, filename), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const REQUIRED_ROLLOUT_FIELDS = [
  "schema_version",
  "rollout_id",
  "task",
  "branch_index",
  "temperature",
  "session_id",
  "tool_call_sequence",
  "final_answer",
];

describe("data-loop fixture", () => {
  it("rollout-branches.v1.jsonl has expected record count", () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")
    ) as { records: Record<string, { count: number }> };
    const records = readJsonl("rollout-branches.v1.jsonl");
    expect(records.length).toBe(manifest.records["rollout-branches.v1.jsonl"].count);
  });

  it("all rollout records have required fields", () => {
    const records = readJsonl("rollout-branches.v1.jsonl") as Record<string, unknown>[];
    for (const r of records) {
      for (const field of REQUIRED_ROLLOUT_FIELDS) {
        expect(r).toHaveProperty(field);
      }
      expect(r.schema_version).toBe("rollout-wire/v1");
    }
  });

  it("branch indices are unique within a rollout", () => {
    const records = readJsonl("rollout-branches.v1.jsonl") as Array<{
      rollout_id: string;
      branch_index: number;
    }>;
    const seen = new Map<string, Set<number>>();
    for (const r of records) {
      const set = seen.get(r.rollout_id) ?? new Set();
      expect(set.has(r.branch_index)).toBe(false);
      set.add(r.branch_index);
      seen.set(r.rollout_id, set);
    }
  });

  it("chosen branch has higher total_score than rejected", () => {
    const records = readJsonl("rollout-branches.v1.jsonl") as Array<{
      rollout_id: string;
      total_score: number;
      rank: number;
    }>;
    const byRollout = new Map<string, typeof records>();
    for (const r of records) {
      const arr = byRollout.get(r.rollout_id) ?? [];
      arr.push(r);
      byRollout.set(r.rollout_id, arr);
    }
    for (const group of byRollout.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => b.total_score - a.total_score);
      expect(sorted[0].total_score).toBeGreaterThan(sorted[1].total_score);
    }
  });
});
