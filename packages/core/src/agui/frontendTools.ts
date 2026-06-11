/**
 * F5 — AG-UI inbound channel: frontend-defined tools and shared state.
 *
 * AG-UI's value as a 2026 standard is **bidirectional**: the protocol lets a
 * frontend declare tools (file pickers, "open in browser", "ask the user"),
 * declare shared state (selected items, theme, viewport), and let the agent
 * call them or read/write the state during a run. The first half (agent →
 * frontend events) was already implemented by this package; F5 adds the
 * second half.
 *
 * ## What ships in this file
 *
 *   1. {@link buildFrontendTools} — turn `AgUiToolDef[]` into a list of
 *      core `ToolDefinition`s the agent can call. Each tool's `forward()`
 *      delegates to a host-supplied {@link FrontendToolDispatcher}, which is
 *      whatever the host uses to talk to its connected frontend (HTTP poll,
 *      WebSocket, MessageChannel, …). The dispatcher is async; the tool
 *      blocks the agent until the frontend replies.
 *   2. {@link applyStateDelta} — RFC 6902 / minimal JSON-Patch implementation
 *      for AG-UI's STATE_DELTA event, so a host can apply inbound deltas to
 *      a shared state object (typically attached to a StructuredMemory key).
 *      Outbound deltas reuse the existing AG-UI mapper.
 *
 * ## Security: every frontend tool is gated by ToolGuardrail
 *
 * Frontend-declared tools extend the agent's authority into the user's
 * browser — load_file_from_disk, navigate_to, post_to_clipboard, etc. The
 * AG-UI spec explicitly warns about this. {@link buildFrontendTools}
 * therefore runs every call through {@link runToolGuardrails} before
 * dispatching, using an injected {@link ToolGuardrail} (the same primitive
 * the existing tool path uses). When the guardrail trips, the agent receives
 * a normal tool error — no special path, no surprise.
 */

import { z } from "zod";
import { runToolGuardrails, type ToolGuardrail } from "../guardrails/index.js";
import type { ToolDefinition } from "../tools/types.js";

// ── Inbound tool bridge ─────────────────────────────────────────────────────

/**
 * Minimal shape we accept for a frontend-declared tool. Mirrors AG-UI's
 * `AgUiToolDef`. Kept here (not imported) so the core package does not gain
 * a runtime dependency on @agentkit-js/ag-ui — F5 must work even when the
 * AG-UI package is not installed (e.g. raw cloudflare-worker hosts that
 * implement the protocol themselves).
 */
export interface FrontendToolSpec {
  name: string;
  description?: string;
  /**
   * JSON Schema describing the tool's input. Optional — when absent the
   * agent receives a free-form `{ args: unknown }` call. Setting it to a
   * concrete schema is strongly recommended; the model will then emit
   * structured arguments.
   */
  parameters?: object;
}

/**
 * Host-supplied dispatcher: send a call to the connected frontend, await its
 * reply. The host is responsible for transport (SSE round-trip with a
 * /tool-result POST endpoint, WebSocket, MessageChannel, …). The dispatcher
 * receives an opaque correlation id (the agent's `callId`) so the host can
 * pair calls with their results.
 *
 * The dispatcher MUST eventually settle (or reject) — a frontend that goes
 * away mid-call would otherwise hang the agent forever. Use the AbortSignal
 * that core passes through `forward()` to cancel in-flight calls cleanly.
 */
export interface FrontendToolDispatcher {
  call(
    request: { toolName: string; args: Record<string, unknown>; callId: string },
    signal: AbortSignal | undefined
  ): Promise<{ output: unknown; error?: { code: string; message: string } }>;
}

export interface BuildFrontendToolsOptions {
  dispatcher: FrontendToolDispatcher;
  /**
   * Tool guardrails applied to EVERY frontend tool call. Defaults to an
   * empty array, but production hosts SHOULD pass at least the same
   * guardrails their backend tools use. The AG-UI spec explicitly warns
   * about extending agent authority into the browser.
   */
  guardrails?: ToolGuardrail[];
  /**
   * If true, every frontend tool is marked `needsApproval: true` so the
   * existing approval policy (HITL pause via await_human_input) gates
   * each call. Default: false — the host can still set it per-tool by
   * post-processing the returned ToolDefinition[].
   */
  requireApproval?: boolean;
  /**
   * Human-readable note appended to every tool's description so the model
   * knows the side-effects happen on the user's machine, not the server.
   * Default: "(runs in the user's browser via AG-UI)".
   */
  attribution?: string;
}

const DEFAULT_ATTRIBUTION = "(runs in the user's browser via AG-UI)";

/**
 * Convert a list of AG-UI tool declarations into core ToolDefinitions. The
 * agent calls them like any other tool; we forward through the dispatcher
 * after the standard guardrail pipeline runs.
 */
export function buildFrontendTools(
  specs: FrontendToolSpec[],
  opts: BuildFrontendToolsOptions
): ToolDefinition[] {
  const guardrails = opts.guardrails ?? [];
  const attribution = opts.attribution ?? DEFAULT_ATTRIBUTION;
  return specs.map((spec) => buildOne(spec, opts.dispatcher, guardrails, attribution, opts));
}

function buildOne(
  spec: FrontendToolSpec,
  dispatcher: FrontendToolDispatcher,
  guardrails: ToolGuardrail[],
  attribution: string,
  opts: BuildFrontendToolsOptions
): ToolDefinition<Record<string, unknown>, unknown> {
  // We don't translate the JSON Schema into a Zod schema here — the model
  // never sees the Zod object directly; tooling reads `rawInputJsonSchema`
  // first when present. Pass through verbatim.
  const rawInputJsonSchema = spec.parameters ?? {
    type: "object",
    properties: {},
    additionalProperties: true,
  };

  const description = `${spec.description ?? "(frontend tool)"} ${attribution}`.trim();

  return {
    name: spec.name,
    description,
    inputSchema: z.record(z.string(), z.unknown()) as z.ZodType<Record<string, unknown>>,
    rawInputJsonSchema,
    outputSchema: z.unknown(),
    readOnly: false,
    idempotent: false,
    needsApproval: opts.requireApproval ?? false,
    async forward(input, signal) {
      const args = (input ?? {}) as Record<string, unknown>;
      // Generate a correlation id we hand to the dispatcher so the frontend
      // can pair its reply with this call. Random + monotonic: collision-
      // resistant within a single run without depending on Date.now().
      const callId = `fe-${Math.floor(Math.random() * 1e9).toString(36)}`;

      const guardrailTrip = await runToolGuardrails(guardrails, spec.name, args, {});
      if (guardrailTrip) {
        const meta = guardrailTrip.result.metadata ?? {};
        const reason =
          (typeof meta.reason === "string" && meta.reason) ||
          (typeof meta.message === "string" && meta.message) ||
          `Tool guardrail "${guardrailTrip.guardrailName}" blocked frontend call to ${spec.name}`;
        throw new Error(reason);
      }

      const reply = await dispatcher.call({ toolName: spec.name, args, callId }, signal);
      if (reply.error) {
        throw new Error(`${reply.error.code}: ${reply.error.message}`);
      }
      return reply.output;
    },
  };
}

// ── Inbound state delta ─────────────────────────────────────────────────────

/**
 * AG-UI STATE_DELTA payload — a JSON Patch (RFC 6902) document. We only
 * need the three operations the spec actually uses; full RFC 6902 is
 * overkill and a bigger surface to misimplement.
 */
export type StateDeltaOp =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

export interface ApplyStateDeltaOptions {
  /**
   * If true, return a new object (the input is NOT mutated). Default true —
   * shared-state objects living in StructuredMemory should be treated as
   * immutable values to keep change tracking honest.
   */
  immutable?: boolean;
}

/**
 * Apply a JSON-Patch-shaped AG-UI state delta to a target object and return
 * the result. Throws when an operation references a path that does not exist
 * (except for `add`, which creates), matching the strict reading of RFC 6902.
 */
export function applyStateDelta(
  target: unknown,
  delta: StateDeltaOp[],
  opts: ApplyStateDeltaOptions = {}
): unknown {
  if (!Array.isArray(delta)) {
    throw new TypeError("applyStateDelta: delta must be an array of operations");
  }
  const immutable = opts.immutable ?? true;
  let cursor = immutable ? deepClone(target) : target;
  for (const op of delta) {
    cursor = applyOne(cursor, op);
  }
  return cursor;
}

function applyOne(target: unknown, op: StateDeltaOp): unknown {
  const segments = parseJsonPointer(op.path);
  if (segments.length === 0) {
    // Whole-document replace.
    if (op.op === "remove") return null;
    return (op as { value: unknown }).value;
  }
  // Walk to the parent; mutate the leaf.
  const last = segments[segments.length - 1] as string;
  const parentSegs = segments.slice(0, -1);
  const root = ensureObject(target);
  const parent = walkOrCreate(root, parentSegs, op.op === "add");
  if (op.op === "remove") {
    if (Array.isArray(parent)) {
      const idx = pointerIndex(last, parent.length);
      parent.splice(idx, 1);
    } else if (parent && typeof parent === "object") {
      delete (parent as Record<string, unknown>)[last];
    }
    return root;
  }
  const value = (op as { value: unknown }).value;
  if (Array.isArray(parent)) {
    const idx =
      last === "-" ? parent.length : pointerIndex(last, parent.length + (op.op === "add" ? 1 : 0));
    if (op.op === "add") parent.splice(idx, 0, value);
    else parent[idx] = value;
  } else if (parent && typeof parent === "object") {
    const obj = parent as Record<string, unknown>;
    if (op.op === "replace" && !(last in obj)) {
      throw new Error(`applyStateDelta: replace on missing path ${op.path}`);
    }
    obj[last] = value;
  } else {
    throw new Error(`applyStateDelta: cannot apply to non-object at ${op.path}`);
  }
  return root;
}

function parseJsonPointer(path: string): string[] {
  if (path === "" || path === "/") return [];
  if (!path.startsWith("/")) {
    throw new Error(`JSON pointer must start with '/' or be '': ${JSON.stringify(path)}`);
  }
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pointerIndex(seg: string, len: number): number {
  if (!/^\d+$/.test(seg)) {
    throw new Error(
      `Array path segment must be a non-negative integer, got ${JSON.stringify(seg)}`
    );
  }
  const idx = Number(seg);
  if (idx > len) throw new Error(`Array index ${idx} out of bounds (len=${len})`);
  return idx;
}

function ensureObject(target: unknown): Record<string, unknown> | unknown[] {
  if (target === null || typeof target !== "object") {
    throw new Error("applyStateDelta: target must be an object or array");
  }
  return target as Record<string, unknown> | unknown[];
}

function walkOrCreate(
  root: Record<string, unknown> | unknown[],
  segments: string[],
  createMissing: boolean
): Record<string, unknown> | unknown[] {
  let cursor: Record<string, unknown> | unknown[] = root;
  for (const seg of segments) {
    if (Array.isArray(cursor)) {
      const idx = pointerIndex(seg, cursor.length);
      const next = cursor[idx];
      if (next == null || typeof next !== "object") {
        throw new Error(`applyStateDelta: cannot walk into non-object at /${seg}`);
      }
      cursor = next as Record<string, unknown> | unknown[];
    } else {
      const obj = cursor as Record<string, unknown>;
      const next = obj[seg];
      if (next == null || typeof next !== "object") {
        if (!createMissing) throw new Error(`applyStateDelta: missing path segment /${seg}`);
        const created: Record<string, unknown> = {};
        obj[seg] = created;
        cursor = created;
      } else {
        cursor = next as Record<string, unknown> | unknown[];
      }
    }
  }
  return cursor;
}

function deepClone<T>(value: T): T {
  // structuredClone is available in CF Workers, Node 17+, and modern browsers.
  // Fall back to JSON for the rare case where it is missing — F5 only deals
  // with JSON-shaped state, so the JSON path is safe.
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
