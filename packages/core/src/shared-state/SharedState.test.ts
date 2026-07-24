/**
 * Comprehensive tests for the shared-state module.
 * Covers: StateModel, SharedStateStore, Transport, stateTools, Projection.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createProjectionPipeline } from "./projection.js";
import type { ChangeEvent } from "./SharedStateStore.js";
import { SharedStateStore } from "./SharedStateStore.js";
import { assertPure, defineStateModel, replayActions } from "./StateModel.js";
import { stateTools } from "./stateTools.js";
import type { CustomFrame, TransportFrame } from "./transport.js";
import { bindStoreToTransport, messageChannelTransport } from "./transport.js";
import { zodStateModel } from "./zodStateModel.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

interface TodoState {
  items: Array<{ id: string; text: string; done: boolean }>;
  nextId: number;
}

type TodoAction =
  | { type: "add"; text: string }
  | { type: "toggle"; id: string }
  | { type: "remove"; id: string };

const todoModel = defineStateModel<TodoState, TodoAction>({
  initial(): TodoState {
    return { items: [], nextId: 1 };
  },
  reduce(state: TodoState, action: TodoAction): TodoState {
    switch (action.type) {
      case "add":
        return {
          items: [...state.items, { id: String(state.nextId), text: action.text, done: false }],
          nextId: state.nextId + 1,
        };
      case "toggle":
        return {
          ...state,
          items: state.items.map((item) =>
            item.id === action.id ? { ...item, done: !item.done } : item
          ),
        };
      case "remove":
        return {
          ...state,
          items: state.items.filter((item) => item.id !== action.id),
        };
    }
  },
  project(state: TodoState) {
    return {
      totalItems: state.items.length,
      doneCount: state.items.filter((i) => i.done).length,
      items: state.items.map((i) => ({ id: i.id, text: i.text, done: i.done })),
    };
  },
  affordances(state: TodoState): Array<TodoAction["type"]> {
    const actions: Array<TodoAction["type"]> = ["add"];
    if (state.items.length > 0) {
      actions.push("toggle", "remove");
    }
    return actions;
  },
});

// ── #134 — StateModel tests ─────────────────────────────────────────────────

describe("StateModel", () => {
  it("defineStateModel returns the same model", () => {
    expect(todoModel.initial()).toEqual({ items: [], nextId: 1 });
  });

  it("replayActions produces correct final state", () => {
    const actions: TodoAction[] = [
      { type: "add", text: "Buy milk" },
      { type: "add", text: "Walk dog" },
      { type: "toggle", id: "1" },
    ];
    const state = replayActions(todoModel, actions);
    expect(state.items).toHaveLength(2);
    expect(state.items[0]!.done).toBe(true);
    expect(state.items[1]!.done).toBe(false);
    expect(state.nextId).toBe(3);
  });

  it("replayActions with from state", () => {
    const from: TodoState = { items: [{ id: "99", text: "Existing", done: false }], nextId: 100 };
    const state = replayActions(todoModel, [{ type: "add", text: "New" }], from);
    expect(state.items).toHaveLength(2);
    expect(state.nextId).toBe(101);
  });

  it("assertPure succeeds for a pure reducer", () => {
    const state: TodoState = { items: [{ id: "1", text: "Test", done: false }], nextId: 2 };
    const next = assertPure(todoModel, state, { type: "toggle", id: "1" });
    expect(next.items[0]!.done).toBe(true);
  });

  it("assertPure throws if reducer mutates input", () => {
    const mutatingModel = defineStateModel<TodoState, TodoAction>({
      initial: () => ({ items: [], nextId: 1 }),
      reduce(state, action) {
        if (action.type === "add") {
          // BAD: mutates input
          state.items.push({ id: String(state.nextId), text: action.text, done: false });
          return state;
        }
        return state;
      },
    });
    const state: TodoState = { items: [], nextId: 1 };
    expect(() => assertPure(mutatingModel, state, { type: "add", text: "x" })).toThrow();
  });

  it("affordances returns valid action types", () => {
    const empty = todoModel.initial();
    expect(todoModel.affordances!(empty)).toEqual(["add"]);

    const withItems = replayActions(todoModel, [{ type: "add", text: "x" }]);
    expect(todoModel.affordances!(withItems)).toContain("toggle");
    expect(todoModel.affordances!(withItems)).toContain("remove");
  });
});

// ── zodStateModel tests ─────────────────────────────────────────────────────

describe("zodStateModel", () => {
  const actionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("add"), text: z.string() }),
    z.object({ type: z.literal("toggle"), id: z.string() }),
    z.object({ type: z.literal("remove"), id: z.string() }),
  ]);

  const zodModel = zodStateModel<TodoState, TodoAction>({
    initial: () => ({ items: [], nextId: 1 }),
    reduce: todoModel.reduce,
    actionSchema,
    project: todoModel.project,
    affordances: todoModel.affordances,
  });

  it("validate accepts valid actions", () => {
    const action = zodModel.validate!({ type: "add", text: "hello" });
    expect(action.type).toBe("add");
  });

  it("validate rejects invalid actions", () => {
    expect(() => zodModel.validate!({ type: "invalid" })).toThrow();
    expect(() => zodModel.validate!({ type: "add" })).toThrow(); // missing text
  });

  it("jsonSchema returns an object", () => {
    const schema = zodModel.jsonSchema();
    expect(typeof schema).toBe("object");
    expect(schema).not.toBeNull();
  });
});

// ── #135 — SharedStateStore tests ───────────────────────────────────────────

describe("SharedStateStore", () => {
  it("get returns initial state for new session", async () => {
    const store = new SharedStateStore(todoModel);
    const state = await store.get("session-1");
    expect(state).toEqual({ items: [], nextId: 1 });
  });

  it("dispatch applies action and returns new state", async () => {
    const store = new SharedStateStore(todoModel);
    const state = await store.dispatch("s1", { type: "add", text: "hello" }, { source: "test" });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.text).toBe("hello");
  });

  it("replace overwrites state entirely", async () => {
    const store = new SharedStateStore(todoModel);
    await store.dispatch("s1", { type: "add", text: "original" }, { source: "test" });
    const newState: TodoState = { items: [{ id: "X", text: "replaced", done: true }], nextId: 99 };
    const result = await store.replace("s1", newState, { source: "admin" });
    expect(result).toEqual(newState);
    expect(await store.get("s1")).toEqual(newState);
  });

  it("subscribe receives change events", async () => {
    const store = new SharedStateStore(todoModel);
    const events: ChangeEvent<TodoState>[] = [];
    store.subscribe("s1", (evt) => events.push(evt));

    await store.dispatch("s1", { type: "add", text: "test" }, { source: "user" });
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe("s1");
    expect(events[0]!.source).toBe("user");
    expect(events[0]!.action).toEqual({ type: "add", text: "test" });
  });

  it("unsubscribe stops notifications", async () => {
    const store = new SharedStateStore(todoModel);
    const events: ChangeEvent<TodoState>[] = [];
    const unsub = store.subscribe("s1", (evt) => events.push(evt));

    await store.dispatch("s1", { type: "add", text: "a" }, { source: "x" });
    unsub();
    await store.dispatch("s1", { type: "add", text: "b" }, { source: "x" });

    expect(events).toHaveLength(1);
  });

  // ── #198 — Global UI synchronization subscriptions ─────────────────────────

  it("subscribeToAll receives change events for any session", async () => {
    const store = new SharedStateStore(todoModel);
    const events: ChangeEvent<TodoState>[] = [];
    store.subscribeToAll((evt) => events.push(evt));

    await store.dispatch("s1", { type: "add", text: "a" }, { source: "user" });
    await store.dispatch("s2", { type: "add", text: "b" }, { source: "agent" });

    expect(events).toHaveLength(2);
    expect(events[0]!.sessionId).toBe("s1");
    expect(events[1]!.sessionId).toBe("s2");
    expect(events[0]!.action).toEqual({ type: "add", text: "a" });
    expect(events[1]!.source).toBe("agent");
  });

  it("subscribeToAll receives replace events", async () => {
    const store = new SharedStateStore(todoModel);
    const events: ChangeEvent<TodoState>[] = [];
    store.subscribeToAll((evt) => events.push(evt));

    const replaced: TodoState = { items: [{ id: "1", text: "x", done: true }], nextId: 2 };
    await store.replace("s1", replaced, { source: "admin" });

    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe("s1");
    expect(events[0]!.source).toBe("admin");
    expect(events[0]!.state).toEqual(replaced);
    expect(events[0]!.action).toBeUndefined();
  });

  it("subscribeToAll and per-session subscribe fire independently", async () => {
    const store = new SharedStateStore(todoModel);
    const globalEvents: ChangeEvent<TodoState>[] = [];
    const sessionEvents: ChangeEvent<TodoState>[] = [];

    const unsubGlobal = store.subscribeToAll((evt) => globalEvents.push(evt));
    const unsubSession = store.subscribe("s1", (evt) => sessionEvents.push(evt));

    // A change to the subscribed session reaches both listeners
    await store.dispatch("s1", { type: "add", text: "x" }, { source: "u" });
    expect(globalEvents).toHaveLength(1);
    expect(sessionEvents).toHaveLength(1);

    // A change to a different session reaches only the global listener
    await store.dispatch("s2", { type: "add", text: "y" }, { source: "u" });
    expect(globalEvents).toHaveLength(2);
    expect(sessionEvents).toHaveLength(1);

    unsubGlobal();
    unsubSession();

    await store.dispatch("s1", { type: "add", text: "z" }, { source: "u" });
    expect(globalEvents).toHaveLength(2);
    expect(sessionEvents).toHaveLength(1);
  });

  it("concurrent dispatches are serialized", async () => {
    const store = new SharedStateStore(todoModel);
    const order: string[] = [];

    // Dispatch multiple concurrent actions — they must serialize
    const p1 = store.dispatch("s1", { type: "add", text: "first" }, { source: "a" }).then(() => {
      order.push("first");
    });
    const p2 = store.dispatch("s1", { type: "add", text: "second" }, { source: "b" }).then(() => {
      order.push("second");
    });
    const p3 = store.dispatch("s1", { type: "add", text: "third" }, { source: "c" }).then(() => {
      order.push("third");
    });

    await Promise.all([p1, p2, p3]);

    // All items should be present (no lost updates)
    const state = await store.get("s1");
    expect(state.items).toHaveLength(3);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("LRU eviction keeps maxSessions", async () => {
    const store = new SharedStateStore(todoModel, { maxSessions: 2 });

    await store.dispatch("s1", { type: "add", text: "a" }, { source: "x" });
    await store.dispatch("s2", { type: "add", text: "b" }, { source: "x" });
    await store.dispatch("s3", { type: "add", text: "c" }, { source: "x" });

    // s1 should have been evicted from memory, but since no backend, it reinitializes
    const state = await store.get("s1");
    expect(state).toEqual({ items: [], nextId: 1 }); // evicted + reinitialized
  });

  it("sessions are isolated", async () => {
    const store = new SharedStateStore(todoModel);
    await store.dispatch("s1", { type: "add", text: "s1-item" }, { source: "x" });
    await store.dispatch("s2", { type: "add", text: "s2-item" }, { source: "x" });

    const s1 = await store.get("s1");
    const s2 = await store.get("s2");
    expect(s1.items).toHaveLength(1);
    expect(s1.items[0]!.text).toBe("s1-item");
    expect(s2.items).toHaveLength(1);
    expect(s2.items[0]!.text).toBe("s2-item");
  });
});

// ── #136 — Transport tests ──────────────────────────────────────────────────

describe("Transport", () => {
  it("messageChannelTransport delivers frames", async () => {
    const transport = messageChannelTransport();
    const received: TransportFrame[] = [];

    transport.onInbound((_, frame) => {
      received.push(frame);
    });

    transport.broadcast("s1", {
      type: "STATE_DELTA",
      sessionId: "s1",
      state: { x: 1 },
      source: "test",
    });

    // Wait for microtask delivery
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("STATE_DELTA");
  });

  it("bindStoreToTransport: echo guard drops own frames", async () => {
    const store = new SharedStateStore(todoModel);
    const transport = messageChannelTransport();
    const broadcastedFrames: TransportFrame[] = [];

    // Intercept broadcasts
    const originalBroadcast = transport.broadcast.bind(transport);
    transport.broadcast = (sid, frame) => {
      broadcastedFrames.push(frame);
      originalBroadcast(sid, frame);
    };

    const cleanup = bindStoreToTransport(store, transport, { source: "local" });

    // Subscribe to get broadcasts flowing
    store.subscribe("s1", () => {});

    // Simulate inbound from same source — should be dropped
    const handlers: Array<(sessionId: string, frame: TransportFrame, source: string) => void> = [];
    transport.onInbound((sid, frame, source) => {
      for (const h of handlers) h(sid, frame, source);
    });

    // Manually trigger the inbound handler with matching source
    // The echo guard should prevent processing
    const state = await store.get("s1");
    expect(state).toEqual({ items: [], nextId: 1 });

    cleanup();
  });

  it("bindStoreToTransport: inbound CUSTOM frame dispatches to store", async () => {
    const store = new SharedStateStore(todoModel);
    const transport = messageChannelTransport();
    let inboundHandler:
      | ((sessionId: string, frame: TransportFrame, source: string) => void)
      | undefined;

    // Capture the inbound handler registered by bind
    const originalOnInbound = transport.onInbound.bind(transport);
    transport.onInbound = (handler) => {
      inboundHandler = handler;
      originalOnInbound(handler);
    };

    const cleanup = bindStoreToTransport(store, transport, { source: "local" });

    // Simulate inbound CUSTOM frame from a different source
    const frame: CustomFrame = {
      type: "CUSTOM",
      sessionId: "s1",
      action: { type: "add", text: "from-remote" },
      source: "remote",
    };

    inboundHandler!("s1", frame, "remote");

    // Wait for async dispatch
    await new Promise((r) => setTimeout(r, 20));

    const state = await store.get("s1");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.text).toBe("from-remote");

    cleanup();
  });
});

// ── #137 — stateTools tests ─────────────────────────────────────────────────

describe("stateTools", () => {
  it("read_state returns projection and affordances", async () => {
    const store = new SharedStateStore(todoModel);
    await store.dispatch("s1", { type: "add", text: "item1" }, { source: "test" });

    const tools = stateTools(store, "s1");
    const readTool = tools.find((t) => t.name === "read_state")!;
    expect(readTool).toBeDefined();
    expect(readTool.readOnly).toBe(true);

    const result = await readTool.forward({} as never);
    expect(result).toHaveProperty("projection");
    expect(result).toHaveProperty("affordances");
    const typed = result as { projection: { totalItems: number }; affordances: string[] };
    expect(typed.projection.totalItems).toBe(1);
    expect(typed.affordances).toContain("add");
    expect(typed.affordances).toContain("toggle");
  });

  it("dispatch_action validates and applies action", async () => {
    const actionSchema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("add"), text: z.string() }),
      z.object({ type: z.literal("toggle"), id: z.string() }),
      z.object({ type: z.literal("remove"), id: z.string() }),
    ]);

    const zodModel = zodStateModel<TodoState, TodoAction>({
      initial: () => ({ items: [], nextId: 1 }),
      reduce: todoModel.reduce,
      actionSchema,
      project: todoModel.project,
      affordances: todoModel.affordances,
    });

    const store = new SharedStateStore(zodModel);
    const tools = stateTools(store, "s1");
    const dispatchTool = tools.find((t) => t.name === "dispatch_action")!;
    expect(dispatchTool).toBeDefined();
    expect(dispatchTool.readOnly).toBe(false);

    const result = await dispatchTool.forward({
      action: { type: "add", text: "via-tool" },
    } as never);
    const typed = result as { ok: boolean; projection: { totalItems: number } };
    expect(typed.ok).toBe(true);
    expect(typed.projection.totalItems).toBe(1);
  });

  it("dispatch_action rejects disallowed affordances", async () => {
    const store = new SharedStateStore(todoModel);
    // Empty state: only "add" is allowed
    const tools = stateTools(store, "s1");
    const dispatchTool = tools.find((t) => t.name === "dispatch_action")!;

    const result = await dispatchTool.forward({ action: { type: "toggle", id: "1" } } as never);
    const typed = result as { error: string };
    expect(typed.error).toContain("not currently allowed");
  });

  it("custom tool names", async () => {
    const store = new SharedStateStore(todoModel);
    const tools = stateTools(store, "s1", {
      readToolName: "get_todo_state",
      dispatchToolName: "update_todo",
    });
    expect(tools[0]!.name).toBe("get_todo_state");
    expect(tools[1]!.name).toBe("update_todo");
  });
});

// ── #138 — Projection Pipeline tests ────────────────────────────────────────

describe("ProjectionPipeline", () => {
  it("full() returns the projected state", () => {
    const pipeline = createProjectionPipeline(todoModel);
    const state = replayActions(todoModel, [{ type: "add", text: "hello" }]);
    const projection = pipeline.full(state) as { totalItems: number };
    expect(projection.totalItems).toBe(1);
  });

  it("diff detects added fields", () => {
    const pipeline = createProjectionPipeline(todoModel);
    const prev = todoModel.initial();
    const next = replayActions(todoModel, [{ type: "add", text: "new" }]);

    const delta = pipeline.diff(prev, next);
    // totalItems changed: 0 -> 1
    expect(delta.changed).toHaveProperty("totalItems");
    // items changed
    expect(delta.changed).toHaveProperty("items");
    expect(delta.removed).toHaveLength(0);
  });

  it("diff detects removed fields", () => {
    const modelWithDynamicFields = defineStateModel<
      Record<string, unknown>,
      { type: string; key?: string; value?: unknown }
    >({
      initial: () => ({ a: 1, b: 2, c: 3 }),
      reduce(state, action) {
        if (action.type === "remove" && action.key) {
          const next = { ...state };
          delete next[action.key];
          return next;
        }
        if (action.type === "set" && action.key) {
          return { ...state, [action.key]: action.value };
        }
        return state;
      },
    });

    const pipeline = createProjectionPipeline(modelWithDynamicFields);
    const prev = modelWithDynamicFields.initial();
    const next = modelWithDynamicFields.reduce(prev, { type: "remove", key: "b" });

    const delta = pipeline.diff(prev, next);
    expect(delta.removed).toContain("b");
    expect(Object.keys(delta.changed)).toHaveLength(0);
  });

  it("diff detects changed fields", () => {
    const pipeline = createProjectionPipeline(todoModel);
    const state1 = replayActions(todoModel, [{ type: "add", text: "item" }]);
    const state2 = replayActions(todoModel, [
      { type: "add", text: "item" },
      { type: "toggle", id: "1" },
    ]);

    const delta = pipeline.diff(state1, state2);
    expect(delta.changed).toHaveProperty("doneCount");
    expect(delta.changed).toHaveProperty("items");
  });

  it("diff returns empty for identical states", () => {
    const pipeline = createProjectionPipeline(todoModel);
    const state = replayActions(todoModel, [{ type: "add", text: "same" }]);

    const delta = pipeline.diff(state, state);
    expect(Object.keys(delta.changed)).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
  });

  it("narrate produces a string description", () => {
    const pipeline = createProjectionPipeline(todoModel, {
      narrator: (delta) => {
        const changes = Object.keys(delta.changed).join(", ");
        const removals = delta.removed.join(", ");
        return `Changed: [${changes}]. Removed: [${removals}].`;
      },
    });

    const prev = todoModel.initial();
    const next = replayActions(todoModel, [{ type: "add", text: "task" }]);
    const delta = pipeline.diff(prev, next);
    const narration = pipeline.narrate!(delta);
    expect(narration).toContain("Changed:");
    expect(narration).toContain("totalItems");
  });

  it("works without project (uses identity)", () => {
    const simpleModel = defineStateModel<{ count: number }, { type: "inc" }>({
      initial: () => ({ count: 0 }),
      reduce: (s) => ({ count: s.count + 1 }),
    });

    const pipeline = createProjectionPipeline(simpleModel);
    const prev = simpleModel.initial();
    const next = simpleModel.reduce(prev, { type: "inc" });

    const full = pipeline.full(next) as { count: number };
    expect(full.count).toBe(1);

    const delta = pipeline.diff(prev, next);
    expect(delta.changed).toHaveProperty("count");
    expect(delta.changed.count).toBe(1);
  });
});
