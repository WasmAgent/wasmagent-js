/**
 * F5 — AG-UI inbound channel tests.
 *
 * Pin down the contract:
 *   - frontend tools turn into ToolDefinitions whose forward() goes through
 *     the dispatcher;
 *   - guardrails fire BEFORE the dispatch — a denied call never crosses the
 *     bridge to the browser;
 *   - dispatcher errors surface as tool errors verbatim;
 *   - requireApproval flips the needsApproval flag uniformly;
 *   - state-delta JSON-Patch ops apply correctly: replace, add, remove,
 *     array splice, "-" append, leaf path validation;
 *   - state-delta is immutable by default — original object is never
 *     mutated unless the caller opts in with { immutable: false }.
 */

import { describe, expect, it, mock } from "bun:test";
import type { ToolGuardrail } from "../guardrails/index.js";
import {
  applyStateDelta,
  buildFrontendTools,
  type FrontendToolDispatcher,
  type StateDeltaOp,
} from "./frontendTools.js";

// ── buildFrontendTools ──────────────────────────────────────────────────────

describe("buildFrontendTools", () => {
  function makeDispatcher(stub?: FrontendToolDispatcher["call"]): FrontendToolDispatcher {
    return { call: stub ?? mock().mockResolvedValue({ output: "ok" }) };
  }

  it("turns each AG-UI tool def into a core ToolDefinition with attribution appended", () => {
    const tools = buildFrontendTools(
      [
        { name: "open_file_picker", description: "Show OS file picker" },
        { name: "navigate_to", description: "Navigate browser tab" },
      ],
      { dispatcher: makeDispatcher() }
    );
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("open_file_picker");
    expect(tools[0]?.description).toMatch(/Show OS file picker/);
    expect(tools[0]?.description).toMatch(/AG-UI/);
    // Default attribution must announce client-side execution.
    expect(tools[0]?.description).toMatch(/browser/);
  });

  it("forwards the model's args through the dispatcher and returns its output", async () => {
    const dispatch = mock().mockResolvedValue({ output: { picked: "/Users/me/notes.md" } });
    const tools = buildFrontendTools([{ name: "pick_file", description: "" }], {
      dispatcher: { call: dispatch },
    });
    const result = await tools[0]?.forward({ kind: "*.md" }, new AbortController().signal);
    expect(result).toEqual({ picked: "/Users/me/notes.md" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [req] = dispatch.mock.calls[0] as [
      { toolName: string; args: Record<string, unknown>; callId: string },
      AbortSignal,
    ];
    expect(req.toolName).toBe("pick_file");
    expect(req.args).toEqual({ kind: "*.md" });
    expect(req.callId).toMatch(/^fe-/);
  });

  it("dispatcher errors surface as tool errors with the structured code/message", async () => {
    const dispatch = mock().mockResolvedValue({
      output: null,
      error: { code: "user_denied", message: "user said no" },
    });
    const tools = buildFrontendTools([{ name: "navigate", description: "" }], {
      dispatcher: { call: dispatch },
    });
    await expect(tools[0]?.forward({ url: "x" }, new AbortController().signal)).rejects.toThrow(
      /user_denied: user said no/
    );
  });

  it("guardrail trip blocks the call before dispatching", async () => {
    const dispatch = mock();
    const blockNavigate: ToolGuardrail = {
      name: "no-nav",
      check(toolName) {
        if (toolName === "navigate") {
          return {
            tripwireTriggered: true,
            metadata: { reason: "navigation forbidden in this run" },
          };
        }
        return { tripwireTriggered: false };
      },
    };
    const tools = buildFrontendTools([{ name: "navigate", description: "" }], {
      dispatcher: { call: dispatch },
      guardrails: [blockNavigate],
    });
    await expect(tools[0]?.forward({ url: "x" }, new AbortController().signal)).rejects.toThrow(
      /navigation forbidden/
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("requireApproval marks every tool with needsApproval = true", () => {
    const tools = buildFrontendTools(
      [
        { name: "a", description: "" },
        { name: "b", description: "" },
      ],
      { dispatcher: { call: mock() }, requireApproval: true }
    );
    expect(tools.every((t) => t.needsApproval === true)).toBe(true);
  });

  it("custom attribution string replaces the default", () => {
    const tools = buildFrontendTools([{ name: "x", description: "do something" }], {
      dispatcher: { call: mock() },
      attribution: "[CLIENT-SIDE]",
    });
    expect(tools[0]?.description).toBe("do something [CLIENT-SIDE]");
  });

  it("preserves the JSON Schema parameters as rawInputJsonSchema", () => {
    const params = {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    };
    const tools = buildFrontendTools([{ name: "open_url", description: "", parameters: params }], {
      dispatcher: { call: mock() },
    });
    expect(tools[0]?.rawInputJsonSchema).toBe(params);
  });
});

// ── applyStateDelta ─────────────────────────────────────────────────────────

describe("applyStateDelta", () => {
  it("replace at a top-level key", () => {
    const before = { theme: "light", count: 1 };
    const after = applyStateDelta(before, [
      { op: "replace", path: "/theme", value: "dark" } as StateDeltaOp,
    ]);
    expect(after).toEqual({ theme: "dark", count: 1 });
    // Immutability: original is untouched.
    expect(before).toEqual({ theme: "light", count: 1 });
  });

  it("add creates missing nested objects", () => {
    const after = applyStateDelta({} as Record<string, unknown>, [
      { op: "add", path: "/user/profile/name", value: "alice" } as StateDeltaOp,
    ]);
    expect(after).toEqual({ user: { profile: { name: "alice" } } });
  });

  it("remove deletes a key from an object", () => {
    const after = applyStateDelta({ a: 1, b: 2 }, [{ op: "remove", path: "/a" } as StateDeltaOp]);
    expect(after).toEqual({ b: 2 });
  });

  it("remove from an array deletes the element and shifts the rest", () => {
    const after = applyStateDelta({ items: ["a", "b", "c"] }, [
      { op: "remove", path: "/items/1" } as StateDeltaOp,
    ]);
    expect(after).toEqual({ items: ["a", "c"] });
  });

  it("add to '-' appends to an array", () => {
    const after = applyStateDelta({ items: ["a"] }, [
      { op: "add", path: "/items/-", value: "b" } as StateDeltaOp,
    ]);
    expect(after).toEqual({ items: ["a", "b"] });
  });

  it("replace on a missing leaf throws (RFC 6902 strict)", () => {
    expect(() =>
      applyStateDelta({ a: 1 }, [{ op: "replace", path: "/missing", value: 1 } as StateDeltaOp])
    ).toThrow(/missing/);
  });

  it("immutable: false mutates the input target in place", () => {
    const before: Record<string, unknown> = { a: 1 };
    const after = applyStateDelta(
      before,
      [{ op: "replace", path: "/a", value: 2 } as StateDeltaOp],
      { immutable: false }
    );
    expect(after).toBe(before);
    expect(before.a).toBe(2);
  });

  it("invalid path (no leading slash) throws", () => {
    expect(() =>
      applyStateDelta({}, [{ op: "add", path: "no-slash", value: 1 } as StateDeltaOp])
    ).toThrow(/pointer/);
  });

  it("array index past length+1 throws", () => {
    expect(() =>
      applyStateDelta({ items: ["a"] }, [
        { op: "add", path: "/items/99", value: "x" } as StateDeltaOp,
      ])
    ).toThrow(/out of bounds/);
  });

  it("multiple ops apply in order; later ops see the result of earlier ones", () => {
    const after = applyStateDelta({ items: [] as string[] }, [
      { op: "add", path: "/items/-", value: "a" } as StateDeltaOp,
      { op: "add", path: "/items/-", value: "b" } as StateDeltaOp,
      { op: "replace", path: "/items/0", value: "A" } as StateDeltaOp,
    ]);
    expect(after).toEqual({ items: ["A", "b"] });
  });
});
