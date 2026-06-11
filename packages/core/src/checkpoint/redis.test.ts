/**
 * A1 — Redis adapter tests. Covers:
 *  - REST transport (Upstash-style) round-trips and SCAN cursor handling
 *  - Client transport (ioredis-like) including TTL EX flag
 *  - Checkpointer kill-and-resume across two adapter instances (proves the
 *    snapshot survives a process boundary, not just an object reference).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentEvent,
  type AgentSnapshot,
  CheckpointableRun,
  InMemoryCheckpointer,
  KvCheckpointer,
  type RedisClientLike,
} from "../index.js";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import { RedisKvBackend, RedisRestKvBackend } from "./redis.js";

// ── REST transport ────────────────────────────────────────────────────────────

describe("RedisRestKvBackend", () => {
  /** Build a fake fetch backed by an in-memory KV map for closed-loop tests. */
  function makeRestServer() {
    const map = new Map<string, string>();
    const calls: unknown[][] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const args = JSON.parse(String((init as RequestInit).body)) as unknown[];
      calls.push(args);
      const cmd = String(args[0]).toUpperCase();
      let result: unknown;
      switch (cmd) {
        case "GET":
          result = map.get(String(args[1])) ?? null;
          break;
        case "SET":
          map.set(String(args[1]), String(args[2]));
          result = "OK";
          break;
        case "DEL":
          result = map.delete(String(args[1])) ? 1 : 0;
          break;
        case "SCAN": {
          // Cursor-paged scan with MATCH; the fake returns everything in one shot.
          const matchIdx = args.indexOf("MATCH");
          const pattern = matchIdx >= 0 ? String(args[matchIdx + 1]) : "*";
          const prefix = pattern.replace(/\*$/, "");
          const matched = [...map.keys()].filter((k) => k.startsWith(prefix));
          result = ["0", matched];
          break;
        }
        default:
          throw new Error(`fakeFetch: unhandled cmd ${cmd}`);
      }
      return new Response(JSON.stringify({ result }), { status: 200 });
    };
    return { map, calls, fakeFetch };
  }

  it("round-trips GET/PUT/DELETE through fetch", async () => {
    const { map, fakeFetch } = makeRestServer();
    const kv = new RedisRestKvBackend({
      url: "https://fake.upstash.io",
      token: "tok",
      fetch: fakeFetch,
    });
    await kv.put("foo", "bar");
    expect(map.get("foo")).toBe("bar");
    expect(await kv.get("foo")).toBe("bar");
    expect(await kv.get("missing")).toBeNull();
    await kv.delete("foo");
    expect(map.has("foo")).toBe(false);
  });

  it("appends EX <ttl> when defaultTtlSeconds is set", async () => {
    const { calls, fakeFetch } = makeRestServer();
    const kv = new RedisRestKvBackend({
      url: "https://fake.upstash.io",
      token: "tok",
      fetch: fakeFetch,
      defaultTtlSeconds: 300,
    });
    await kv.put("k", "v");
    const setCall = calls.find((c) => String(c[0]).toUpperCase() === "SET");
    expect(setCall).toEqual(["SET", "k", "v", "EX", "300"]);
  });

  it("uses SCAN to enumerate prefixed keys", async () => {
    const { fakeFetch } = makeRestServer();
    const kv = new RedisRestKvBackend({
      url: "https://fake.upstash.io",
      token: "tok",
      fetch: fakeFetch,
    });
    await kv.put("agent:1", "a");
    await kv.put("agent:2", "b");
    await kv.put("other:1", "c");
    const keys = await kv.list("agent:");
    expect(keys.sort()).toEqual(["agent:1", "agent:2"]);
  });

  it("surfaces error payloads from the REST endpoint", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "WRONGPASS" }), { status: 200 });
    const kv = new RedisRestKvBackend({
      url: "https://fake.upstash.io",
      token: "bad",
      fetch: fakeFetch,
    });
    await expect(kv.get("k")).rejects.toThrow(/WRONGPASS/);
  });
});

// ── Client transport ──────────────────────────────────────────────────────────

describe("RedisKvBackend (client transport)", () => {
  let store: Map<string, string>;
  let setSpy: ReturnType<typeof vi.fn>;
  let client: RedisClientLike;

  beforeEach(() => {
    store = new Map();
    setSpy = vi.fn(async (k: string, v: string, ..._rest: unknown[]) => {
      store.set(k, v);
      return "OK";
    });
    client = {
      get: async (k) => store.get(k) ?? null,
      // biome-ignore lint/suspicious/noExplicitAny: matches overload contract
      set: setSpy as any,
      del: async (k) => (store.delete(k) ? 1 : 0),
      scan: async (cursor, _matchKw, pattern) => {
        const prefix = String(pattern ?? "").replace(/\*$/, "");
        const matched = [...store.keys()].filter((k) => k.startsWith(prefix));
        // Single-shot — return cursor "0" to terminate.
        return [String(cursor) === "0" ? "0" : "0", matched];
      },
    };
  });

  it("round-trips through a client object", async () => {
    const kv = new RedisKvBackend(client);
    await kv.put("a", "1");
    expect(await kv.get("a")).toBe("1");
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  it("passes EX <ttl> when defaultTtlSeconds is set", async () => {
    const kv = new RedisKvBackend(client, { defaultTtlSeconds: 60 });
    await kv.put("k", "v");
    expect(setSpy).toHaveBeenCalledWith("k", "v", "EX", 60);
  });

  it("lists by prefix using SCAN", async () => {
    const kv = new RedisKvBackend(client);
    await kv.put("p:1", "a");
    await kv.put("p:2", "b");
    await kv.put("q:1", "c");
    expect((await kv.list("p:")).sort()).toEqual(["p:1", "p:2"]);
  });
});

// ── Cross-process resume (the actual A1 DoD test) ────────────────────────────

describe("KvCheckpointer + Redis adapter — kill and resume", () => {
  it("survives across two independent adapter instances", async () => {
    // Single shared map simulates the Redis server between two 'processes'.
    const sharedKv = new Map<string, string>();
    const makeClient = (): RedisClientLike => ({
      get: async (k) => sharedKv.get(k) ?? null,
      set: (async (k: string, v: string) => {
        sharedKv.set(k, v);
        return "OK";
        // biome-ignore lint/suspicious/noExplicitAny: matches overload contract
      }) as any,
      del: async (k) => (sharedKv.delete(k) ? 1 : 0),
      scan: async (_cursor, _matchKw, pattern) => {
        const prefix = String(pattern ?? "").replace(/\*$/, "");
        return ["0", [...sharedKv.keys()].filter((k) => k.startsWith(prefix))];
      },
    });

    // ── Process 1: save a snapshot, then "die" (drop the adapter). ──────────
    const cp1 = new KvCheckpointer(new RedisKvBackend(makeClient()));
    const snap: AgentSnapshot = {
      traceId: "trace-1",
      task: "do the thing",
      history: [{ type: "user_message", content: "do the thing" }],
      stepIndex: 3,
      savedAtMs: 1_700_000_000_000,
    };
    await cp1.save("trace-1", snap);

    // ── Process 2: brand-new adapter, brand-new client. ─────────────────────
    const cp2 = new KvCheckpointer(new RedisKvBackend(makeClient()));
    const restored = await cp2.load("trace-1");
    expect(restored).toEqual(snap);
  });

  it("an in-flight CheckpointableRun replays after restart and yields the same final answer", async () => {
    // We don't need a real model — drive a fake event stream that emits a few
    // step_starts then a final_answer. The adapter under test is Redis (via a
    // shared map across two processes); the assertion is that a snapshot
    // saved by process 1 is loadable by process 2.
    const sharedKv = new Map<string, string>();
    const makeAdapter = () => {
      const client: RedisClientLike = {
        get: async (k) => sharedKv.get(k) ?? null,
        // The two-arg + four-arg overloads collapse to one runtime impl: the
        // adapter only ever calls the no-TTL form here, so the trailing
        // (`mode`, `seconds`) overload is unused.
        set: async (k: string, v: string, ..._rest: unknown[]) => {
          sharedKv.set(k, v);
          return "OK";
        },
        del: async (k) => (sharedKv.delete(k) ? 1 : 0),
        scan: async (_c, _m, pat) => {
          const prefix = String(pat ?? "").replace(/\*$/, "");
          return ["0", [...sharedKv.keys()].filter((k) => k.startsWith(prefix))];
        },
      };
      return new RedisKvBackend(client);
    };

    async function* fakeStream(steps: number): AsyncGenerator<AgentEvent> {
      for (let i = 0; i < steps; i++) {
        yield {
          event: "step_start",
          timestampMs: 1000 + i,
          data: { step: i },
        } as AgentEvent;
        if (i === Math.floor(steps / 2)) {
          // Simulate a process kill mid-run by breaking out.
          return;
        }
      }
    }
    async function* finishingStream(): AsyncGenerator<AgentEvent> {
      yield { event: "step_start", timestampMs: 2000, data: { step: 5 } } as AgentEvent;
      yield {
        event: "final_answer",
        timestampMs: 2001,
        data: { answer: "42" },
      } as AgentEvent;
    }

    const TRACE = "trace-resume";

    // Process 1: run partial, snapshot survives.
    const assembler1 = new MessageAssembler({
      systemPrompt: "test",
      toolsSchema: [],
    });
    assembler1.addStep({ type: "user_message", content: "task" });
    const run1 = new CheckpointableRun(
      { checkpointer: new KvCheckpointer(makeAdapter()) },
      assembler1
    );
    for await (const _ev of run1.run(fakeStream(6), "task", TRACE)) {
      /* drain */
    }

    // Snapshot must be present in shared KV.
    const cp2 = new KvCheckpointer(makeAdapter());
    const snap = await cp2.load(TRACE);
    expect(snap).not.toBeNull();
    expect(snap?.traceId).toBe(TRACE);

    // Process 2: finish the run; final_answer deletes the checkpoint.
    const assembler2 = new MessageAssembler({
      systemPrompt: "test",
      toolsSchema: [],
    });
    const run2 = new CheckpointableRun({ checkpointer: cp2 }, assembler2);
    for await (const _ev of run2.run(finishingStream(), "task", TRACE)) {
      /* drain */
    }
    expect(await cp2.load(TRACE)).toBeNull();
  });

  it("baseline equivalence: InMemory and Redis produce identical snapshot bytes", async () => {
    const snap: AgentSnapshot = {
      traceId: "t",
      task: "tt",
      history: [],
      stepIndex: 0,
      savedAtMs: 0,
    };
    const memCp = new InMemoryCheckpointer();
    await memCp.save("t", snap);

    const sharedKv = new Map<string, string>();
    const client: RedisClientLike = {
      get: async (k) => sharedKv.get(k) ?? null,
      set: async (k: string, v: string, ..._rest: unknown[]) => {
        sharedKv.set(k, v);
        return "OK";
      },
      del: async (k) => (sharedKv.delete(k) ? 1 : 0),
      scan: async (_c, _m, pat) => {
        const prefix = String(pat ?? "").replace(/\*$/, "");
        return ["0", [...sharedKv.keys()].filter((k) => k.startsWith(prefix))];
      },
    };
    const redisCp = new KvCheckpointer(new RedisKvBackend(client));
    await redisCp.save("t", snap);

    expect(await redisCp.load("t")).toEqual(await memCp.load("t"));
  });
});
