/**
 * D1 schema + helpers for run history.
 *
 * Stores every agent run (started, completed, failed, cancelled) so
 * the user can list past runs, replay events, and aggregate token /
 * cost usage.
 *
 * The schema is intentionally minimal — extend by adding nullable
 * columns rather than altering existing ones.
 */

export const RUN_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  task TEXT NOT NULL,
  agent_type TEXT,
  model TEXT,
  status TEXT NOT NULL,
  final_answer TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_runs ON runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_status ON runs(status);
`;

/** Cloudflare D1 database interface — minimal subset we need. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  user_id: string | null;
  task: string;
  agent_type: string | null;
  model: string | null;
  status: RunStatus;
  final_answer: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  duration_ms: number;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface InsertRunInput {
  id: string;
  userId?: string;
  task: string;
  agentType?: string;
  model?: string;
}

export async function ensureSchema(db: D1Database): Promise<void> {
  // D1 supports running multi-statement DDL via exec.
  await db.exec(RUN_HISTORY_SCHEMA.replace(/\s+/g, " ").trim());
}

export async function insertRun(db: D1Database, input: InsertRunInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (id, user_id, task, agent_type, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.userId ?? null,
      input.task,
      input.agentType ?? null,
      input.model ?? null,
      "running",
      Date.now()
    )
    .run();
}

export interface CompleteRunInput {
  id: string;
  finalAnswer?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  status?: RunStatus;
}

export async function completeRun(db: D1Database, input: CompleteRunInput): Promise<void> {
  await db
    .prepare(
      `UPDATE runs
       SET status = ?,
           final_answer = ?,
           input_tokens = ?,
           output_tokens = ?,
           cache_read_tokens = ?,
           cost_usd = ?,
           duration_ms = ?,
           error = ?,
           completed_at = ?
       WHERE id = ?`
    )
    .bind(
      input.status ?? (input.error ? "failed" : "completed"),
      input.finalAnswer ?? null,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.cacheReadTokens ?? 0,
      input.costUsd ?? 0,
      input.durationMs ?? 0,
      input.error ?? null,
      Date.now(),
      input.id
    )
    .run();
}

export interface ListRunsOpts {
  userId?: string;
  limit?: number;
  before?: number; // created_at filter
}

export async function listRuns(db: D1Database, opts: ListRunsOpts = {}): Promise<RunRecord[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (opts.userId) {
    conditions.push("user_id = ?");
    args.push(opts.userId);
  }
  if (opts.before !== undefined) {
    conditions.push("created_at < ?");
    args.push(opts.before);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const stmt = db.prepare(sql).bind(...args);
  const result = await stmt.all<RunRecord>();
  return result.results;
}

export async function getRun(db: D1Database, id: string): Promise<RunRecord | null> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRecord>();
}

export interface AggregateOpts {
  userId?: string;
  from?: number;
  to?: number;
}

export interface AggregateResult {
  total_runs: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  avg_duration_ms: number;
}

export async function aggregateRuns(
  db: D1Database,
  opts: AggregateOpts = {}
): Promise<AggregateResult> {
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (opts.userId) {
    conditions.push("user_id = ?");
    args.push(opts.userId);
  }
  if (opts.from !== undefined) {
    conditions.push("created_at >= ?");
    args.push(opts.from);
  }
  if (opts.to !== undefined) {
    conditions.push("created_at <= ?");
    args.push(opts.to);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT
    COUNT(*) as total_runs,
    COALESCE(SUM(input_tokens), 0) as total_input_tokens,
    COALESCE(SUM(output_tokens), 0) as total_output_tokens,
    COALESCE(SUM(cost_usd), 0) as total_cost_usd,
    COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM runs ${where}`;
  const stmt = args.length > 0 ? db.prepare(sql).bind(...args) : db.prepare(sql);
  const row = await stmt.first<AggregateResult>();
  return (
    row ?? {
      total_runs: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      avg_duration_ms: 0,
    }
  );
}
