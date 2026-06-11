import { describe, expect, it } from "vitest";
import {
  type AggregateResult,
  aggregateRuns,
  completeRun,
  type D1Database,
  ensureSchema,
  getRun,
  insertRun,
  listRuns,
  type RunRecord,
} from "./db.js";

/**
 * Tiny in-process D1 simulator. Implements just enough of the prepare /
 * bind / first / all / run / exec API to exercise our SQL-shaping logic
 * without booting wrangler / Miniflare.
 */
class FakeD1 implements D1Database {
  private rows: RunRecord[] = [];

  prepare(sql: string) {
    return new FakeStmt(this.rows, sql);
  }

  async exec(_sql: string) {
    return { count: 0, duration: 0 };
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(
    private readonly rows: RunRecord[],
    private readonly sql: string
  ) {}

  bind(...values: unknown[]) {
    this.args = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const matched = this.#match();
    if (this.sql.includes("COUNT(*)")) {
      return this.#aggregate(matched) as unknown as T;
    }
    return (matched[0] as unknown as T) ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.#match() as unknown as T[] };
  }

  async run() {
    if (this.sql.startsWith("INSERT")) {
      const [id, user_id, task, agent_type, model, status, created_at] = this.args as [
        string,
        string | null,
        string,
        string | null,
        string | null,
        string,
        number,
      ];
      this.rows.push({
        id,
        user_id,
        task,
        agent_type,
        model,
        status: status as RunRecord["status"],
        final_answer: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: 0,
        duration_ms: 0,
        error: null,
        created_at,
        completed_at: null,
      });
    } else if (this.sql.startsWith("UPDATE")) {
      const last = this.args[this.args.length - 1] as string;
      const idx = this.rows.findIndex((r) => r.id === last);
      if (idx >= 0) {
        const row = this.rows[idx];
        if (!row) return Promise.resolve({ success: true, meta: { changes: 0 } });
        const [
          status,
          finalAnswer,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          costUsd,
          durationMs,
          error,
          completedAt,
        ] = this.args as [
          string,
          string | null,
          number,
          number,
          number,
          number,
          number,
          string | null,
          number,
        ];
        row.status = status as RunRecord["status"];
        row.final_answer = finalAnswer;
        row.input_tokens = inputTokens;
        row.output_tokens = outputTokens;
        row.cache_read_tokens = cacheReadTokens;
        row.cost_usd = costUsd;
        row.duration_ms = durationMs;
        row.error = error;
        row.completed_at = completedAt;
      }
    }
    return { success: true, meta: { changes: 1 } };
  }

  #match(): RunRecord[] {
    if (this.sql.includes("WHERE id = ?")) {
      return this.rows.filter((r) => r.id === this.args[0]);
    }
    let result = [...this.rows];
    // Honor user_id and created_at filters in order they appear in args.
    let argIdx = 0;
    if (this.sql.includes("user_id = ?")) {
      result = result.filter((r) => r.user_id === this.args[argIdx]);
      argIdx++;
    }
    if (this.sql.includes("created_at < ?")) {
      result = result.filter((r) => r.created_at < (this.args[argIdx] as number));
      argIdx++;
    }
    if (this.sql.includes("created_at >= ?")) {
      result = result.filter((r) => r.created_at >= (this.args[argIdx] as number));
      argIdx++;
    }
    if (this.sql.includes("created_at <= ?")) {
      result = result.filter((r) => r.created_at <= (this.args[argIdx] as number));
      argIdx++;
    }
    if (this.sql.includes("ORDER BY created_at DESC")) {
      result.sort((a, b) => b.created_at - a.created_at);
    }
    if (this.sql.includes("LIMIT ?")) {
      const limit = this.args[argIdx] as number;
      result = result.slice(0, limit);
    }
    return result;
  }

  #aggregate(rows: RunRecord[]): AggregateResult {
    return {
      total_runs: rows.length,
      total_input_tokens: rows.reduce((s, r) => s + r.input_tokens, 0),
      total_output_tokens: rows.reduce((s, r) => s + r.output_tokens, 0),
      total_cost_usd: rows.reduce((s, r) => s + r.cost_usd, 0),
      avg_duration_ms:
        rows.length === 0 ? 0 : rows.reduce((s, r) => s + r.duration_ms, 0) / rows.length,
    };
  }
}

describe("db helpers", () => {
  it("ensureSchema runs without throwing", async () => {
    await ensureSchema(new FakeD1());
  });

  it("insertRun + getRun round-trip", async () => {
    const db = new FakeD1();
    await insertRun(db, { id: "r1", task: "test task", userId: "u1" });
    const got = await getRun(db, "r1");
    expect(got?.task).toBe("test task");
    expect(got?.user_id).toBe("u1");
    expect(got?.status).toBe("running");
  });

  it("completeRun updates status and metrics", async () => {
    const db = new FakeD1();
    await insertRun(db, { id: "r1", task: "x", userId: "u" });
    await completeRun(db, {
      id: "r1",
      finalAnswer: "yes",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      durationMs: 5000,
    });
    const got = await getRun(db, "r1");
    expect(got?.status).toBe("completed");
    expect(got?.final_answer).toBe("yes");
    expect(got?.input_tokens).toBe(100);
  });

  it("completeRun sets failed status when error provided", async () => {
    const db = new FakeD1();
    await insertRun(db, { id: "r2", task: "x" });
    await completeRun(db, { id: "r2", error: "boom" });
    const got = await getRun(db, "r2");
    expect(got?.status).toBe("failed");
    expect(got?.error).toBe("boom");
  });

  it("listRuns filters by user and respects limit", async () => {
    const db = new FakeD1();
    await insertRun(db, { id: "a", task: "t", userId: "u1" });
    await insertRun(db, { id: "b", task: "t", userId: "u1" });
    await insertRun(db, { id: "c", task: "t", userId: "u2" });
    const u1 = await listRuns(db, { userId: "u1" });
    expect(u1).toHaveLength(2);
    const limited = await listRuns(db, { userId: "u1", limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("aggregateRuns sums tokens + cost", async () => {
    const db = new FakeD1();
    await insertRun(db, { id: "a", task: "t", userId: "u" });
    await insertRun(db, { id: "b", task: "t", userId: "u" });
    await completeRun(db, {
      id: "a",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      durationMs: 1000,
    });
    await completeRun(db, {
      id: "b",
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.003,
      durationMs: 2000,
    });
    const agg = await aggregateRuns(db, { userId: "u" });
    expect(agg.total_runs).toBe(2);
    expect(agg.total_input_tokens).toBe(300);
    expect(agg.total_cost_usd).toBeCloseTo(0.004, 6);
  });
});
