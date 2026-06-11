/**
 * A1 — Cloudflare Workers KV + Durable Object storage adapter tests.
 * Covers basic round-trips, paged list(), and a kill/resume cycle through
 * `KvCheckpointer` to prove a checkpoint survives across two adapter
 * instances using the same underlying namespace/storage.
 */

import { type AgentSnapshot, KvCheckpointer } from "@agentkit-js/core";
import { describe, expect, it } from "vitest";
import {
  type CloudflareKVNamespace,
  CloudflareKvBackend,
  DurableObjectKvBackend,
  type DurableObjectStorageLike,
} from "./kvAdapters.js";

// ── Cloudflare Workers KV ─────────────────────────────────────────────────────

/** In-memory fake of the bits of `KVNamespace` we use. */
class FakeKVNamespace implements CloudflareKVNamespace {
  readonly map = new Map<string, string>();
  async get(key: string, _options?: { type: "text" }): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const startIdx = options?.cursor ? Number(options.cursor) : 0;
    const slice = all.slice(startIdx, startIdx + limit);
    const nextIdx = startIdx + slice.length;
    const complete = nextIdx >= all.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      ...(complete ? {} : { cursor: String(nextIdx) }),
    };
  }
}

describe("CloudflareKvBackend", () => {
  it("round-trips through get/put/delete", async () => {
    const ns = new FakeKVNamespace();
    const kv = new CloudflareKvBackend(ns);
    await kv.put("a", "1");
    expect(await kv.get("a")).toBe("1");
    expect(await kv.get("missing")).toBeNull();
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  it("pages list() over multiple cursor calls", async () => {
    const ns = new FakeKVNamespace();
    // Seed 2500 keys — more than the per-page limit (1000) to force pagination.
    for (let i = 0; i < 2500; i++) ns.map.set(`agent:${String(i).padStart(4, "0")}`, "v");
    const kv = new CloudflareKvBackend(ns);
    const keys = await kv.list("agent:");
    expect(keys.length).toBe(2500);
  });

  it("filters by prefix", async () => {
    const ns = new FakeKVNamespace();
    await ns.put("agent:1", "a");
    await ns.put("agent:2", "b");
    await ns.put("other:1", "c");
    const kv = new CloudflareKvBackend(ns);
    expect((await kv.list("agent:")).sort()).toEqual(["agent:1", "agent:2"]);
  });
});

// ── Durable Object Storage ────────────────────────────────────────────────────

/** In-memory fake of the parts of DO storage we use. */
class FakeDurableObjectStorage implements DurableObjectStorageLike {
  readonly map = new Map<string, unknown>();
  async get<T = unknown>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      const result = new Map<string, T>();
      for (const k of key) {
        const v = this.map.get(k);
        if (v !== undefined) result.set(k, v as T);
      }
      return result;
    }
    return this.map.get(key) as T | undefined;
  }
  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const out = new Map<string, T>();
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) out.set(k, v as T);
      if (options?.limit !== undefined && out.size >= options.limit) break;
    }
    return out;
  }
}

describe("DurableObjectKvBackend", () => {
  it("round-trips through get/put/delete", async () => {
    const storage = new FakeDurableObjectStorage();
    const kv = new DurableObjectKvBackend(storage);
    await kv.put("a", "1");
    expect(await kv.get("a")).toBe("1");
    expect(await kv.get("missing")).toBeNull();
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  it("lists by prefix", async () => {
    const storage = new FakeDurableObjectStorage();
    const kv = new DurableObjectKvBackend(storage);
    await kv.put("agent:1", "a");
    await kv.put("agent:2", "b");
    await kv.put("other:1", "c");
    expect((await kv.list("agent:")).sort()).toEqual(["agent:1", "agent:2"]);
  });
});

// ── DoD: kill-and-resume across two adapter instances ────────────────────────

describe("KvCheckpointer + CF adapters — kill and resume", () => {
  it("CloudflareKvBackend: snapshot survives across adapter instances", async () => {
    const sharedNs = new FakeKVNamespace();
    const cp1 = new KvCheckpointer(new CloudflareKvBackend(sharedNs));
    const snap: AgentSnapshot = {
      traceId: "trace-cf",
      task: "do thing",
      history: [{ type: "user_message", content: "do thing" }],
      stepIndex: 7,
      savedAtMs: 1_700_000_000_000,
    };
    await cp1.save("trace-cf", snap);

    // Brand-new adapter, brand-new checkpointer, same backing namespace.
    const cp2 = new KvCheckpointer(new CloudflareKvBackend(sharedNs));
    expect(await cp2.load("trace-cf")).toEqual(snap);
  });

  it("DurableObjectKvBackend: snapshot survives across adapter instances", async () => {
    const sharedStorage = new FakeDurableObjectStorage();
    const cp1 = new KvCheckpointer(new DurableObjectKvBackend(sharedStorage));
    const snap: AgentSnapshot = {
      traceId: "trace-do",
      task: "do thing",
      history: [],
      stepIndex: 0,
      savedAtMs: 0,
    };
    await cp1.save("trace-do", snap);

    const cp2 = new KvCheckpointer(new DurableObjectKvBackend(sharedStorage));
    expect(await cp2.load("trace-do")).toEqual(snap);
  });

  it("respond() persists humanResponse across adapter instances (HITL precursor)", async () => {
    const sharedNs = new FakeKVNamespace();
    const cp1 = new KvCheckpointer(new CloudflareKvBackend(sharedNs));
    await cp1.save("t", {
      traceId: "t",
      task: "t",
      history: [],
      stepIndex: 0,
      savedAtMs: 0,
      pendingHumanInput: { promptId: "p1", prompt: "approve?" },
    });

    // 'Process 2' provides the human response.
    const cp2 = new KvCheckpointer(new CloudflareKvBackend(sharedNs));
    await cp2.respond("t", "p1", "yes");

    // 'Process 3' loads — sees the response.
    const cp3 = new KvCheckpointer(new CloudflareKvBackend(sharedNs));
    const snap = await cp3.load("t");
    expect(snap?.humanResponse).toEqual({ promptId: "p1", response: "yes" });
  });
});
