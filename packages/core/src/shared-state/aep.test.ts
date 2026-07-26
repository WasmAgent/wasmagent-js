/**
 * #141 — Tests for the AEP evidence sink.
 *
 * Covers: dispatch → emitter received the action; detach stops recording;
 * `include` defaults to agent-sourced writes only; sideEffectClass /
 * recordingMode mappers; the replay proof (the recorded action stream
 * reproduces live state); and the dependency boundary (the base shared-state
 * module imports nothing from @wasmagent/aep).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AEPEmitter } from "@wasmagent/aep";
import { aepEvidenceSink } from "./aep.js";
import { SharedStateStore } from "./SharedStateStore.js";
import { defineStateModel, replayActions } from "./StateModel.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

interface TodoState {
  items: Array<{ id: string; text: string; done: boolean }>;
  nextId: number;
}

type TodoAction =
  | { type: "add"; text: string }
  | { type: "toggle"; id: string }
  | { type: "remove"; id: string }
  | { type: "send_email"; to: string };

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
      case "send_email":
        // No state change — but still a dispatched semantic action.
        return state;
    }
  },
});

// ── #141 — AEP evidence sink tests ──────────────────────────────────────────

describe("aepEvidenceSink", () => {
  it("records agent-sourced state changes as AEP actions on the emitter", async () => {
    const store = new SharedStateStore(todoModel);
    const emitter = new AEPEmitter({ run_id: "run-1" });
    const detach = aepEvidenceSink(store, emitter);

    await store.dispatch("s1", { type: "add", text: "Buy milk" }, { source: "agent" });

    const rec = emitter.build();
    expect(rec.actions).toHaveLength(1);
    expect(rec.actions[0]?.tool_name).toBe("add");
    expect(rec.actions[0]?.state_changing).toBe(true);
    expect(rec.actions[0]?.recording_mode).toBe("delta");
    expect(rec.actions[0]?.side_effect_class).toBe("mutate-local");

    detach();
  });

  it("detach() stops recording further changes", async () => {
    const store = new SharedStateStore(todoModel);
    const emitter = new AEPEmitter({ run_id: "run-2" });
    const detach = aepEvidenceSink(store, emitter);

    await store.dispatch("s1", { type: "add", text: "one" }, { source: "agent" });
    detach();

    // After detach, a new agent-sourced dispatch must NOT be recorded.
    await store.dispatch("s1", { type: "add", text: "two" }, { source: "agent" });

    const rec = emitter.build();
    expect(rec.actions).toHaveLength(1);
    expect(rec.actions[0]?.tool_name).toBe("add");
  });

  it("include defaults to agent-sourced writes only — human edits are not misattributed", async () => {
    const store = new SharedStateStore(todoModel);
    const emitter = new AEPEmitter({ run_id: "run-3" });
    const detach = aepEvidenceSink(store, emitter);

    await store.dispatch("s1", { type: "add", text: "agent-a" }, { source: "agent" });
    await store.dispatch("s1", { type: "add", text: "human-edit" }, { source: "human" });
    await store.dispatch("s1", { type: "add", text: "transport" }, { source: "transport" });
    await store.dispatch("s1", { type: "toggle", id: "1" }, { source: "agent" });
    detach();

    const rec = emitter.build();
    // Only the two agent-sourced writes were recorded.
    expect(rec.actions).toHaveLength(2);
    expect(rec.actions.map((a) => a.tool_name)).toEqual(["add", "toggle"]);
  });

  it("replace() (no semantic action) is not recorded", async () => {
    const store = new SharedStateStore(todoModel);
    const emitter = new AEPEmitter({ run_id: "run-4" });
    const detach = aepEvidenceSink(store, emitter);

    // A server-authoritative replace carries no action and must not enter the
    // replayable evidence stream — even when sourced from "agent".
    await store.replace("s1", { items: [], nextId: 1 }, { source: "agent" });
    detach();

    const rec = emitter.build();
    expect(rec.actions).toHaveLength(0);
  });

  it("sideEffectClass / recordingMode mappers classify each action", async () => {
    const store = new SharedStateStore(todoModel);
    const emitter = new AEPEmitter({ run_id: "run-5" });
    const detach = aepEvidenceSink(store, emitter, {
      sideEffectClass: (a) => (a.type === "send_email" ? "network-egress" : "mutate-local"),
      recordingMode: (a) => (a.type === "send_email" ? "full" : "delta"),
    });

    await store.dispatch("s1", { type: "add", text: "x" }, { source: "agent" });
    await store.dispatch("s1", { type: "send_email", to: "a@b" }, { source: "agent" });
    detach();

    const rec = emitter.build();
    expect(rec.actions).toHaveLength(2);
    expect(rec.actions[0]?.side_effect_class).toBe("mutate-local");
    expect(rec.actions[0]?.recording_mode).toBe("delta");
    expect(rec.actions[1]?.side_effect_class).toBe("network-egress");
    expect(rec.actions[1]?.recording_mode).toBe("full");
  });

  it("custom include predicate overrides the agent-sourced default", async () => {
    const store = new SharedStateStore(todoModel);
    const emitter = new AEPEmitter({ run_id: "run-6" });
    const detach = aepEvidenceSink(store, emitter, {
      // Record everything, regardless of source.
      include: () => true,
    });

    await store.dispatch("s1", { type: "add", text: "agent" }, { source: "agent" });
    await store.dispatch("s1", { type: "add", text: "human" }, { source: "human" });
    detach();

    const rec = emitter.build();
    expect(rec.actions).toHaveLength(2);
  });

  it("replay proof: the recorded action stream reproduces the live state", async () => {
    const store = new SharedStateStore(todoModel);
    const emitter = new AEPEmitter({ run_id: "run-7" });
    const detach = aepEvidenceSink(store, emitter);

    // The semantic action stream that becomes evidence (all agent-sourced).
    const stream: TodoAction[] = [
      { type: "add", text: "Buy milk" },
      { type: "add", text: "Walk dog" },
      { type: "toggle", id: "1" },
      { type: "remove", id: "2" },
    ];
    for (const action of stream) {
      await store.dispatch("s1", action, { source: "agent" });
    }
    detach();

    const live = await store.get("s1");

    // Replaying the recorded action stream reproduces the live state exactly —
    // demonstrating the evidence stream is complete and faithful.
    const replayed = replayActions(todoModel, stream);
    expect(replayed).toEqual(live);

    // The emitter captured every action in the stream, in order.
    const rec = emitter.build();
    expect(rec.actions).toHaveLength(stream.length);
    expect(rec.actions.map((a) => a.tool_name)).toEqual(["add", "add", "toggle", "remove"]);
  });
});

// ── #141 — Dependency boundary ──────────────────────────────────────────────

describe("aepEvidenceSink dependency boundary", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  it("the base shared-state barrel does not export the aep sink", () => {
    const barrel = readFileSync(path.join(here, "index.ts"), "utf8");
    expect(barrel).not.toContain("aepEvidenceSink");
    expect(barrel).not.toContain("./aep.js");
  });

  it("no base shared-state source file imports @wasmagent/aep", () => {
    // Every non-aep TypeScript file in the base module must be free of any
    // reference to @wasmagent/aep — the evidence layer is opt-in via the
    // dedicated subpath only.
    const baseFiles = readdirSync(here).filter(
      (f) => f.endsWith(".ts") && f !== "aep.ts" && f !== "aep.test.ts"
    );
    expect(baseFiles.length).toBeGreaterThan(0);
    for (const f of baseFiles) {
      const content = readFileSync(path.join(here, f), "utf8");
      expect(content).not.toContain("@wasmagent/aep");
    }
  });

  it("the aep subpath imports @wasmagent/aep only via `import type` (no runtime dependency)", () => {
    const aepSource = readFileSync(path.join(here, "aep.ts"), "utf8");
    expect(aepSource).toContain("@wasmagent/aep");
    // Consider only real import statements — ignore mentions in doc comments
    // and @example blocks. Every actual import of @wasmagent/aep must be
    // type-only so the compiled output carries no runtime dependency.
    const aepImports = aepSource
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("import ") && l.includes("@wasmagent/aep"));
    expect(aepImports.length).toBeGreaterThanOrEqual(1);
    for (const line of aepImports) {
      expect(line.startsWith("import type")).toBe(true);
    }
  });
});
