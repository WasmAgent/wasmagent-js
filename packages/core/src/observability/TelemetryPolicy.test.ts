/**
 * TelemetryPolicy tests (#389) — retention, redaction, export batching.
 */

import { describe, expect, it } from "bun:test";
import { MapKvBackend } from "../memory/MemoryTool.js";
import {
  applyRetention,
  BatchingExporter,
  type RetentionPolicy,
  redactText,
  redactValue,
} from "./TelemetryPolicy.js";

describe("redactText / redactValue", () => {
  const opts = {
    rules: [{ match: /sk-[a-zA-Z0-9]{8,}/g }, { match: "secret.project", replaceWith: "<proj>" }],
  };

  it("replaces regex and literal matches with [redacted] by default", () => {
    const out = redactText("key=sk-abcdef123456 in secret.project", opts);
    expect(out).toBe("key=[redacted] in <proj>");
  });

  it("honours replaceWith overrides", () => {
    expect(
      redactText("token sk-zzzzzzzz1", { rules: [{ match: /sk-\w+/, replaceWith: "***" }] })
    ).toBe("token ***");
  });

  it("no-op with empty rules", () => {
    expect(redactText("sk-abcdef123456", { rules: [] })).toBe("sk-abcdef123456");
  });

  it("deep-redacts strings inside nested objects and arrays", () => {
    const input = {
      tool: "write_file",
      args: { path: "secret.project/a.md", body: ["token sk-abcdef123456", 42, null] },
      ok: true,
    };
    const out = redactValue(input, opts) as typeof input;
    expect(out.args.path).toBe("<proj>/a.md");
    expect(out.args.body[0]).toBe("token [redacted]");
    expect(out.args.body[1]).toBe(42);
    expect(out.ok).toBe(true);
    // original untouched (pure)
    expect(input.args.path).toBe("secret.project/a.md");
  });
});

describe("applyRetention", () => {
  function seededKv(): MapKvBackend {
    const kv = new MapKvBackend();
    // 5 evlog entries, timestamps 0..4 (only even ones carry timestamps;
    // odd ones are timestamp-less and must be treated as newest).
    for (let i = 0; i < 5; i++) {
      const value =
        i % 2 === 0 ? JSON.stringify({ timestampMs: 1_000 + i }) : JSON.stringify({ payload: i });
      void kv.put(`evlog:t1:${String(i).padStart(8, "0")}`, value);
    }
    void kv.put("obs:s1:0", JSON.stringify({ createdAtMs: 900 }));
    return kv;
  }

  it("deletes records older than maxAgeMs within the prefix only", async () => {
    const kv = seededKv();
    const policy: RetentionPolicy = { prefix: "evlog:", maxAgeMs: 2_500 };
    const deleted = await applyRetention(kv, policy, { nowMs: 4_000 });
    // cutoff = now - maxAge = 1500 → ts 1000/1002/1004 all aged out.
    expect(deleted).toBe(3);
    expect(await kv.get("evlog:t1:00000000")).toBeNull();
    expect(await kv.get("evlog:t1:00000002")).toBeNull();
    expect(await kv.get("evlog:t1:00000004")).toBeNull();
    // timestamp-less entries are never aged out…
    expect(await kv.get("evlog:t1:00000001")).not.toBeNull();
    // …and other prefixes are untouched.
    expect(await kv.get("obs:s1:0")).not.toBeNull();
  });

  it("enforces maxRecords keeping the newest", async () => {
    const kv = seededKv();
    const deleted = await applyRetention(kv, { prefix: "evlog:", maxRecords: 2 }, { nowMs: 9_999 });
    expect(deleted).toBe(3);
    // Newest two survive: the timestamp-less entries (sorted last = newest).
    expect(await kv.get("evlog:t1:00000001")).not.toBeNull();
    expect(await kv.get("evlog:t1:00000003")).not.toBeNull();
    expect(await kv.get("evlog:t1:00000000")).toBeNull();
  });

  it("returns 0 when neither knob is set or list() is missing", async () => {
    const kv = seededKv();
    expect(await applyRetention(kv, { prefix: "evlog:" }, { nowMs: 9_999 })).toBe(0);
    const noList = {
      get: (key: string) => Promise.resolve(kv.get(key)),
      put: (key: string, value: string) => kv.put(key, value),
      delete: (key: string) => kv.delete(key),
    };
    expect(await applyRetention(noList, { prefix: "evlog:", maxRecords: 1 })).toBe(0);
  });
});

describe("BatchingExporter", () => {
  it("flushes when the batch fills and on explicit flush", async () => {
    const batches: number[][] = [];
    const ex = new BatchingExporter<number>((batch) => {
      batches.push(batch);
    }, 3);
    ex.push(1);
    ex.push(2);
    expect(ex.size).toBe(2);
    ex.push(3); // full → flush
    expect(batches).toEqual([[1, 2, 3]]);
    ex.push(4);
    expect(ex.size).toBe(1);
    await ex.flush();
    expect(batches).toEqual([[1, 2, 3], [4]]);
    expect(ex.size).toBe(0);
  });

  it("flush on empty is a no-op; batchSize < 1 throws", () => {
    const ex = new BatchingExporter<number>(() => {}, 2);
    expect(ex.size).toBe(0);
    expect(() => new BatchingExporter<number>(() => {}, 0)).toThrow(/batchSize/);
  });
});
