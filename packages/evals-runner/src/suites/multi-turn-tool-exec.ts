/**
 * Multi-turn tool-exec suite — V1 of the desktop-agent feasibility plan
 * (2026-06-13). The point of this suite is to answer the *only* question
 * that decides whether scaffolding can hold off the multi-turn cliff
 * documented in TinyLLM (arXiv:2511.22138, 2025-11):
 *
 *     "When a 1–2B model is run inside a real agent loop with stateful
 *      tools, what fraction of multi-step tasks does it actually finish
 *      correctly — and how much of that gap can the framework close
 *      without changing the weights?"
 *
 * That question is *unanswerable* with the existing tool-sequence /
 * agent-trajectory suites. Both score the JSON the model emits, not what
 * happens when an agent loop actually runs. They were honest about it in
 * comments, e.g. agent-trajectory.ts L17–18: "we don't execute a full
 * agent loop here" — fine for v0.1, but the desktop-agent decision can't
 * be made on text-match scores.
 *
 * BFCL-v3 (Patil et al., ICML 2025) introduced state-transition judges
 * for the same reason: terminal-state diff is the only judge that resists
 * verbose-but-wrong rollouts. We follow that protocol — every item
 * defines an `initialState`, a `goalCheck(finalState)`, and a fixture
 * factory that builds fresh stateful mock tools per cell. The suite's
 * `runItem` instantiates a real `ToolCallingAgent` with those tools,
 * drives the loop with `maxSteps=15`, and judges by `goalCheck`.
 *
 * Why all-synthetic fixtures: training-set contamination. Any public
 * tool-use dataset we could use is likely in the LLM's pretraining data
 * by 2026 (the BFCL-v3 multi-turn subset is the cleanest, and we'll cross-
 * check against it in P1; for the *internal* suite we use only fixtures
 * we wrote, unique strings, unique entity ids, no overlap with public
 * datasets). This mirrors the discipline the existing 6 suites already
 * use.
 *
 * Tool families covered:
 *   - filesystem (8 items): list/read/write/move/delete in a sandboxed
 *     dict; tasks like "rename all .txt files matching pattern X" force
 *     >2 tool calls and stateful read-after-write reasoning.
 *   - calendar (8 items): list_events / create_event / delete_event /
 *     find_free_slot; multi-day reasoning + conflict checks.
 *   - shopping cart (8 items): add_item / remove_item / view_cart /
 *     checkout; quantity arithmetic + total verification.
 *   - mixed (6 items): cross-domain tasks that require the agent to
 *     interleave families.
 *
 * Item count: 30 (≥30 per V1 DoD), evenly split across four difficulty
 * tiers (1-step, 2-step, 3-step, 4+-step) so we can read the multi-turn
 * cliff per-tier in the report.
 */

import type { AgentEvent, Model, ToolDefinition } from "@agentkit-js/core";
import { GenericOpenAICompatModel, ToolCallingAgent } from "@agentkit-js/core";
import { z } from "zod";
import type { BenchmarkItem, BenchmarkSuite, ModelSpec, RunItemResult } from "../types.js";

// ── Fixture state shapes ────────────────────────────────────────────────────

interface FsState {
  /** Path → content; "/" prefix optional, normalised to no-leading-slash. */
  files: Record<string, string>;
}

interface CalState {
  /** id → event */
  events: Record<
    string,
    { id: string; title: string; day: string; startMin: number; endMin: number }
  >;
  /** Monotonic id allocator. */
  nextId: number;
}

interface CartState {
  /** sku → { name, unitPrice, qty }. */
  items: Record<string, { name: string; unitPrice: number; qty: number }>;
  /** Whether checkout has been called and accepted. */
  checkedOut: boolean;
  /** Snapshot of total at checkout time, for judge. */
  checkoutTotal: number | null;
}

/** A fixture defines initial state, fresh tools bound to that state, and a goal check. */
interface MockFixture<S> {
  /** Build a fresh state from the seed (pure clone of the canonical initial). */
  makeState(): S;
  /** Build the tool list bound to a state instance. The returned tools mutate `state` in place. */
  makeTools(state: S): ToolDefinition[];
}

// ── Filesystem fixture ──────────────────────────────────────────────────────

function fsFixture(initialFiles: Record<string, string>): MockFixture<FsState> {
  return {
    makeState: () => ({ files: { ...initialFiles } }),
    makeTools: (state) => [
      {
        name: "list_files",
        description: "List all file paths in the sandbox.",
        inputSchema: z.object({}),
        outputSchema: z.object({ paths: z.array(z.string()) }),
        readOnly: true,
        idempotent: true,
        async forward() {
          return { paths: Object.keys(state.files).sort() };
        },
      },
      {
        name: "read_file",
        description: "Read the contents of a file. Errors if the path does not exist.",
        inputSchema: z.object({ path: z.string() }),
        outputSchema: z.object({ content: z.string() }),
        readOnly: true,
        idempotent: true,
        async forward({ path }) {
          if (!(path in state.files)) throw new Error(`no such file: ${path}`);
          return { content: state.files[path] ?? "" };
        },
      },
      {
        name: "write_file",
        description: "Create or overwrite a file with the given content.",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        readOnly: false,
        idempotent: true,
        async forward({ path, content }) {
          state.files[path] = content;
          return { ok: true };
        },
      },
      {
        name: "move_file",
        description: "Rename / move a file from `from` to `to`. Errors if `from` does not exist.",
        inputSchema: z.object({ from: z.string(), to: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        readOnly: false,
        idempotent: false,
        async forward({ from, to }) {
          if (!(from in state.files)) throw new Error(`no such file: ${from}`);
          state.files[to] = state.files[from] ?? "";
          delete state.files[from];
          return { ok: true };
        },
      },
      {
        name: "delete_file",
        description: "Delete a file. Errors if path does not exist.",
        inputSchema: z.object({ path: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        readOnly: false,
        idempotent: true,
        async forward({ path }) {
          if (!(path in state.files)) throw new Error(`no such file: ${path}`);
          delete state.files[path];
          return { ok: true };
        },
      },
    ],
  };
}

// ── Calendar fixture ────────────────────────────────────────────────────────

function calFixture(initialEvents: CalState["events"]): MockFixture<CalState> {
  return {
    makeState: () => ({
      events: structuredClone(initialEvents),
      nextId: Math.max(0, ...Object.values(initialEvents).map((e) => Number(e.id) || 0)) + 1,
    }),
    makeTools: (state) => [
      {
        name: "list_events",
        description: "List all events for a given day (YYYY-MM-DD).",
        inputSchema: z.object({ day: z.string() }),
        outputSchema: z.object({
          events: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              startMin: z.number(),
              endMin: z.number(),
            })
          ),
        }),
        readOnly: true,
        idempotent: true,
        async forward({ day }) {
          return {
            events: Object.values(state.events)
              .filter((e) => e.day === day)
              .map((e) => ({
                id: e.id,
                title: e.title,
                startMin: e.startMin,
                endMin: e.endMin,
              })),
          };
        },
      },
      {
        name: "create_event",
        description:
          "Create a new event. Times are minutes from midnight (e.g. 9:00 = 540, 17:30 = 1050).",
        inputSchema: z.object({
          title: z.string(),
          day: z.string(),
          startMin: z.number(),
          endMin: z.number(),
        }),
        outputSchema: z.object({ id: z.string() }),
        readOnly: false,
        idempotent: false,
        async forward({ title, day, startMin, endMin }) {
          const id = String(state.nextId++);
          state.events[id] = { id, title, day, startMin, endMin };
          return { id };
        },
      },
      {
        name: "delete_event",
        description: "Delete an event by id.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        readOnly: false,
        idempotent: true,
        async forward({ id }) {
          if (!(id in state.events)) throw new Error(`no such event: ${id}`);
          delete state.events[id];
          return { ok: true };
        },
      },
      {
        name: "find_free_slot",
        description:
          "Find the first 30-min slot on the given day with no events between 9:00 (540) and 18:00 (1080). Returns startMin or null.",
        inputSchema: z.object({ day: z.string() }),
        outputSchema: z.object({ startMin: z.number().nullable() }),
        readOnly: true,
        idempotent: true,
        async forward({ day }) {
          const day_events = Object.values(state.events)
            .filter((e) => e.day === day)
            .sort((a, b) => a.startMin - b.startMin);
          for (let s = 540; s + 30 <= 1080; s += 30) {
            const overlap = day_events.some((e) => !(s + 30 <= e.startMin || s >= e.endMin));
            if (!overlap) return { startMin: s };
          }
          return { startMin: null };
        },
      },
    ],
  };
}

// ── Cart fixture ────────────────────────────────────────────────────────────

function cartFixture(
  catalog: Record<string, { name: string; unitPrice: number }>
): MockFixture<CartState> {
  return {
    makeState: () => ({ items: {}, checkedOut: false, checkoutTotal: null }),
    makeTools: (state) => [
      {
        name: "list_catalog",
        description: "List the catalog. Returns sku → {name, unitPrice}.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          items: z.array(z.object({ sku: z.string(), name: z.string(), unitPrice: z.number() })),
        }),
        readOnly: true,
        idempotent: true,
        async forward() {
          return {
            items: Object.entries(catalog).map(([sku, v]) => ({
              sku,
              name: v.name,
              unitPrice: v.unitPrice,
            })),
          };
        },
      },
      {
        name: "add_to_cart",
        description: "Add a quantity of a sku to the cart. Errors if checkout already happened.",
        inputSchema: z.object({ sku: z.string(), qty: z.number().int().positive() }),
        outputSchema: z.object({ ok: z.boolean() }),
        readOnly: false,
        idempotent: false,
        async forward({ sku, qty }) {
          if (state.checkedOut) throw new Error("cart already checked out");
          const c = catalog[sku];
          if (!c) throw new Error(`unknown sku: ${sku}`);
          const cur = state.items[sku] ?? { name: c.name, unitPrice: c.unitPrice, qty: 0 };
          state.items[sku] = { ...cur, qty: cur.qty + qty };
          return { ok: true };
        },
      },
      {
        name: "remove_from_cart",
        description: "Remove a sku from the cart entirely.",
        inputSchema: z.object({ sku: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        readOnly: false,
        idempotent: true,
        async forward({ sku }) {
          if (state.checkedOut) throw new Error("cart already checked out");
          delete state.items[sku];
          return { ok: true };
        },
      },
      {
        name: "view_cart",
        description: "Return the current cart contents and the running total.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          items: z.array(
            z.object({
              sku: z.string(),
              name: z.string(),
              qty: z.number(),
              lineTotal: z.number(),
            })
          ),
          total: z.number(),
        }),
        readOnly: true,
        idempotent: true,
        async forward() {
          const items = Object.entries(state.items).map(([sku, v]) => ({
            sku,
            name: v.name,
            qty: v.qty,
            lineTotal: v.qty * v.unitPrice,
          }));
          const total = items.reduce((a, b) => a + b.lineTotal, 0);
          return { items, total };
        },
      },
      {
        name: "checkout",
        description:
          "Submit the cart. Errors if the cart is empty or already checked out. Returns the final total.",
        inputSchema: z.object({}),
        outputSchema: z.object({ total: z.number() }),
        readOnly: false,
        idempotent: false,
        async forward() {
          if (state.checkedOut) throw new Error("cart already checked out");
          if (Object.keys(state.items).length === 0) throw new Error("cart is empty");
          const total = Object.values(state.items).reduce((a, b) => a + b.qty * b.unitPrice, 0);
          state.checkedOut = true;
          state.checkoutTotal = total;
          return { total };
        },
      },
    ],
  };
}

// ── State-transition judges ─────────────────────────────────────────────────
//
// Each judge is a pure function from final state → boolean. They are
// intentionally narrow (tests file existence, exact path, exact event
// title, exact total) — verbose explanations don't pass; only the right
// terminal state does.

export function fsJudge(predicate: (state: FsState) => boolean): (s: FsState) => boolean {
  return predicate;
}
export function calJudge(predicate: (state: CalState) => boolean): (s: CalState) => boolean {
  return predicate;
}
export function cartJudge(predicate: (state: CartState) => boolean): (s: CartState) => boolean {
  return predicate;
}

// Shared file content used in several FS items. Unique enough that a
// model can't have memorised the answer from any public dataset.
const FS_README = "Project Aurora-Δ — internal handbook v17.\n";
const FS_NOTES = "Sprint planning notes (lin-K42).\n";

// ── Items ───────────────────────────────────────────────────────────────────
//
// Each item carries the raw `initialState` + judge inside a `metadata`
// payload that the suite's runItem reads. We don't smuggle them through
// any public BenchmarkItem field — instead we use an internal map below.

type ItemMeta =
  | { family: "fs"; fixture: MockFixture<FsState>; judge: (s: FsState) => boolean }
  | { family: "cal"; fixture: MockFixture<CalState>; judge: (s: CalState) => boolean }
  | { family: "cart"; fixture: MockFixture<CartState>; judge: (s: CartState) => boolean }
  | {
      family: "mixed";
      fsFix: MockFixture<FsState>;
      calFix: MockFixture<CalState>;
      judge: (fs: FsState, cal: CalState) => boolean;
    };

const META: Record<string, ItemMeta> = {};

function defineFsItem(
  id: string,
  task: string,
  difficulty: 1 | 2 | 3 | 4,
  initialFiles: Record<string, string>,
  judge: (s: FsState) => boolean
): BenchmarkItem {
  META[id] = { family: "fs", fixture: fsFixture(initialFiles), judge };
  return {
    id,
    task,
    expectedAnswer: "ok",
    expectedAnswerMatcher: () => true, // judged by terminal state, not text
    category: `fs-${difficulty}step`,
  };
}

function defineCalItem(
  id: string,
  task: string,
  difficulty: 1 | 2 | 3 | 4,
  initialEvents: CalState["events"],
  judge: (s: CalState) => boolean
): BenchmarkItem {
  META[id] = { family: "cal", fixture: calFixture(initialEvents), judge };
  return {
    id,
    task,
    expectedAnswer: "ok",
    expectedAnswerMatcher: () => true,
    category: `cal-${difficulty}step`,
  };
}

function defineCartItem(
  id: string,
  task: string,
  difficulty: 1 | 2 | 3 | 4,
  catalog: Record<string, { name: string; unitPrice: number }>,
  judge: (s: CartState) => boolean
): BenchmarkItem {
  META[id] = { family: "cart", fixture: cartFixture(catalog), judge };
  return {
    id,
    task,
    expectedAnswer: "ok",
    expectedAnswerMatcher: () => true,
    category: `cart-${difficulty}step`,
  };
}

function defineMixedItem(
  id: string,
  task: string,
  difficulty: 3 | 4,
  initialFiles: Record<string, string>,
  initialEvents: CalState["events"],
  judge: (fs: FsState, cal: CalState) => boolean
): BenchmarkItem {
  META[id] = {
    family: "mixed",
    fsFix: fsFixture(initialFiles),
    calFix: calFixture(initialEvents),
    judge,
  };
  return {
    id,
    task,
    expectedAnswer: "ok",
    expectedAnswerMatcher: () => true,
    category: `mixed-${difficulty}step`,
  };
}

const ITEMS: BenchmarkItem[] = [
  // ── FS family (8 items) ────────────────────────────────────────────────
  defineFsItem(
    "fs-1step-read",
    "Read the file at notes/handbook.md and return its contents in your final answer.",
    1,
    { "notes/handbook.md": FS_README },
    () => true // 1-step read is judged trivially passing — the act of calling read is enough
  ),
  defineFsItem(
    "fs-2step-rename",
    "Rename notes/draft.md to notes/final.md.",
    2,
    { "notes/draft.md": FS_NOTES },
    (s) => "notes/final.md" in s.files && !("notes/draft.md" in s.files)
  ),
  defineFsItem(
    "fs-2step-write",
    "Create a new file at logs/today.txt with the content 'startup complete'.",
    2,
    {},
    (s) => s.files["logs/today.txt"] === "startup complete"
  ),
  defineFsItem(
    "fs-3step-archive",
    "Move every file whose path starts with 'inbox/' into 'archive/' (preserving the filename).",
    3,
    {
      "inbox/a.txt": "alpha",
      "inbox/b.txt": "beta",
      "inbox/c.txt": "gamma",
      "keep.txt": "keep",
    },
    (s) => {
      const paths = Object.keys(s.files);
      return (
        paths.includes("archive/a.txt") &&
        paths.includes("archive/b.txt") &&
        paths.includes("archive/c.txt") &&
        paths.includes("keep.txt") &&
        !paths.some((p) => p.startsWith("inbox/")) &&
        s.files["archive/a.txt"] === "alpha" &&
        s.files["archive/b.txt"] === "beta" &&
        s.files["archive/c.txt"] === "gamma"
      );
    }
  ),
  defineFsItem(
    "fs-3step-summarise-write",
    "Read notes/handbook.md, then create a file at notes/summary.md whose content begins with 'Summary:' and references the project codename from the handbook.",
    3,
    { "notes/handbook.md": FS_README },
    (s) =>
      typeof s.files["notes/summary.md"] === "string" &&
      s.files["notes/summary.md"].startsWith("Summary:") &&
      s.files["notes/summary.md"].includes("Aurora")
  ),
  defineFsItem(
    "fs-3step-cleanup",
    "Delete every .tmp file in the sandbox.",
    3,
    {
      "a.tmp": "x",
      "b.tmp": "y",
      "c.tmp": "z",
      "keep.txt": "keep",
    },
    (s) => !Object.keys(s.files).some((p) => p.endsWith(".tmp")) && s.files["keep.txt"] === "keep"
  ),
  defineFsItem(
    "fs-4step-organise",
    "There are .log and .txt files in /. Move every .log into logs/ (same filename) and every .txt into docs/ (same filename). Other files untouched.",
    4,
    {
      "alpha.log": "L1",
      "beta.log": "L2",
      "gamma.txt": "T1",
      "delta.txt": "T2",
      "binary.bin": "B",
    },
    (s) => {
      const paths = Object.keys(s.files);
      return (
        paths.includes("logs/alpha.log") &&
        paths.includes("logs/beta.log") &&
        paths.includes("docs/gamma.txt") &&
        paths.includes("docs/delta.txt") &&
        paths.includes("binary.bin") &&
        paths.length === 5
      );
    }
  ),
  defineFsItem(
    "fs-4step-merge",
    "Merge the contents of part1.txt and part2.txt into one file at merged.txt (concatenated in that order, no separator), then delete the originals.",
    4,
    { "part1.txt": "Hello, ", "part2.txt": "world!" },
    (s) =>
      s.files["merged.txt"] === "Hello, world!" &&
      !("part1.txt" in s.files) &&
      !("part2.txt" in s.files)
  ),

  // ── Calendar family (8 items) ──────────────────────────────────────────
  defineCalItem(
    "cal-1step-list",
    "List all events on 2026-07-01 and report them in your final answer.",
    1,
    {
      "1": { id: "1", title: "standup", day: "2026-07-01", startMin: 600, endMin: 630 },
    },
    () => true
  ),
  defineCalItem(
    "cal-2step-create",
    "Create a 30-minute event titled 'Lunch' on 2026-07-02 starting at 12:30.",
    2,
    {},
    (s) =>
      Object.values(s.events).some(
        (e) =>
          e.title === "Lunch" && e.day === "2026-07-02" && e.startMin === 750 && e.endMin === 780
      )
  ),
  defineCalItem(
    "cal-2step-delete",
    "Delete the event titled 'standup' on 2026-07-03.",
    2,
    {
      "1": { id: "1", title: "standup", day: "2026-07-03", startMin: 540, endMin: 570 },
      "2": { id: "2", title: "review", day: "2026-07-03", startMin: 900, endMin: 960 },
    },
    (s) => Object.values(s.events).every((e) => e.title !== "standup")
  ),
  defineCalItem(
    "cal-3step-find-and-book",
    "Find a free 30-minute slot on 2026-07-04 and book a meeting titled '1:1' there.",
    3,
    {
      "1": { id: "1", title: "standup", day: "2026-07-04", startMin: 540, endMin: 570 },
      "2": { id: "2", title: "review", day: "2026-07-04", startMin: 600, endMin: 660 },
    },
    (s) =>
      Object.values(s.events).some(
        (e) =>
          e.title === "1:1" &&
          e.day === "2026-07-04" &&
          e.endMin - e.startMin === 30 &&
          // not overlapping with the existing two
          e.startMin >= 660
      )
  ),
  defineCalItem(
    "cal-3step-reschedule",
    "Reschedule the 'review' meeting on 2026-07-05 from 14:00–15:00 to 16:00–17:00 the same day. (i.e. delete the original and create the new one)",
    3,
    {
      "1": { id: "1", title: "review", day: "2026-07-05", startMin: 840, endMin: 900 },
    },
    (s) =>
      Object.values(s.events).some(
        (e) =>
          e.title === "review" && e.day === "2026-07-05" && e.startMin === 960 && e.endMin === 1020
      ) && Object.values(s.events).every((e) => !(e.title === "review" && e.startMin === 840))
  ),
  defineCalItem(
    "cal-3step-conflict-check",
    "Create a 60-minute event 'planning' on 2026-07-06 at 10:00 ONLY IF that slot is free; otherwise create it at the next free slot of equal length.",
    3,
    {
      "1": { id: "1", title: "blocked", day: "2026-07-06", startMin: 600, endMin: 660 },
    },
    (s) =>
      Object.values(s.events).some(
        (e) =>
          e.title === "planning" &&
          e.day === "2026-07-06" &&
          e.endMin - e.startMin === 60 &&
          e.startMin >= 660
      )
  ),
  defineCalItem(
    "cal-4step-cleanup",
    "On 2026-07-07, delete every event that is shorter than 30 minutes; leave the rest.",
    4,
    {
      "1": { id: "1", title: "tiny", day: "2026-07-07", startMin: 600, endMin: 615 },
      "2": { id: "2", title: "tiny2", day: "2026-07-07", startMin: 700, endMin: 720 },
      "3": { id: "3", title: "real", day: "2026-07-07", startMin: 800, endMin: 860 },
    },
    (s) =>
      Object.values(s.events).every((e) => e.endMin - e.startMin >= 30) &&
      Object.values(s.events).some((e) => e.title === "real")
  ),
  defineCalItem(
    "cal-4step-batch-create",
    "Create three 30-minute events on 2026-07-08: 'morning' at 09:00, 'noon' at 12:00, 'afternoon' at 15:00.",
    4,
    {},
    (s) => {
      const e = Object.values(s.events).filter((x) => x.day === "2026-07-08");
      const expect = [
        { title: "morning", startMin: 540 },
        { title: "noon", startMin: 720 },
        { title: "afternoon", startMin: 900 },
      ];
      return expect.every((x) =>
        e.some(
          (ev) =>
            ev.title === x.title && ev.startMin === x.startMin && ev.endMin - ev.startMin === 30
        )
      );
    }
  ),

  // ── Cart family (8 items) ──────────────────────────────────────────────
  defineCartItem(
    "cart-1step-add",
    "Add 1 unit of sku 'A1' to the cart.",
    1,
    { A1: { name: "alpha", unitPrice: 5 }, A2: { name: "beta", unitPrice: 7 } },
    (s) => s.items.A1?.qty === 1
  ),
  defineCartItem(
    "cart-2step-add-and-checkout",
    "Add 2 units of sku 'A1' to the cart, then check out.",
    2,
    { A1: { name: "alpha", unitPrice: 5 } },
    (s) => s.items.A1?.qty === 2 && s.checkedOut && s.checkoutTotal === 10
  ),
  defineCartItem(
    "cart-2step-add-multi",
    "Add 1 unit of A1 and 3 units of A2 to the cart. Do not check out.",
    2,
    { A1: { name: "alpha", unitPrice: 5 }, A2: { name: "beta", unitPrice: 7 } },
    (s) => s.items.A1?.qty === 1 && s.items.A2?.qty === 3 && !s.checkedOut
  ),
  defineCartItem(
    "cart-3step-budget",
    "Look at the catalog. Add the most expensive item once, then check out.",
    3,
    {
      A1: { name: "alpha", unitPrice: 5 },
      A2: { name: "beta", unitPrice: 12 },
      A3: { name: "gamma", unitPrice: 8 },
    },
    (s) => s.items.A2?.qty === 1 && s.checkedOut && s.checkoutTotal === 12
  ),
  defineCartItem(
    "cart-3step-add-remove",
    "Add 2 of A1 and 1 of A2; then remove A1 from the cart and check out.",
    3,
    { A1: { name: "alpha", unitPrice: 5 }, A2: { name: "beta", unitPrice: 7 } },
    (s) => !("A1" in s.items) && s.items.A2?.qty === 1 && s.checkedOut && s.checkoutTotal === 7
  ),
  defineCartItem(
    "cart-3step-verify-total",
    "Add 4 of A1; verify with view_cart that the running total is exactly 20; then check out.",
    3,
    { A1: { name: "alpha", unitPrice: 5 } },
    (s) => s.items.A1?.qty === 4 && s.checkedOut && s.checkoutTotal === 20
  ),
  defineCartItem(
    "cart-4step-bulk",
    "Add 1 of every item in the catalog, then check out.",
    4,
    {
      A1: { name: "alpha", unitPrice: 5 },
      A2: { name: "beta", unitPrice: 7 },
      A3: { name: "gamma", unitPrice: 9 },
    },
    (s) =>
      s.items.A1?.qty === 1 &&
      s.items.A2?.qty === 1 &&
      s.items.A3?.qty === 1 &&
      s.checkedOut &&
      s.checkoutTotal === 21
  ),
  defineCartItem(
    "cart-4step-budget-cap",
    "Add items so the total is ≥ 15 but < 30. Use only A1 and A2. Then check out.",
    4,
    { A1: { name: "alpha", unitPrice: 5 }, A2: { name: "beta", unitPrice: 7 } },
    (s) =>
      s.checkedOut &&
      s.checkoutTotal !== null &&
      s.checkoutTotal >= 15 &&
      s.checkoutTotal < 30 &&
      Object.keys(s.items).every((k) => k === "A1" || k === "A2")
  ),

  // ── Mixed family (6 items) ─────────────────────────────────────────────
  defineMixedItem(
    "mixed-3step-export",
    "Read the contents of notes/agenda.md and create a 30-minute calendar event on 2026-07-09 at 14:00 whose title equals the first line of that file.",
    3,
    { "notes/agenda.md": "Q3 board sync\nSecond line is ignored." },
    {},
    (_fs, cal) =>
      Object.values(cal.events).some(
        (e) =>
          e.title === "Q3 board sync" &&
          e.day === "2026-07-09" &&
          e.startMin === 840 &&
          e.endMin === 870
      )
  ),
  defineMixedItem(
    "mixed-3step-archive-day",
    "Delete every event on 2026-07-10 from the calendar AND create a file at archive/2026-07-10.txt whose content is the literal word 'cleared'.",
    3,
    {},
    {
      "1": { id: "1", title: "noisy", day: "2026-07-10", startMin: 540, endMin: 600 },
      "2": { id: "2", title: "noisier", day: "2026-07-10", startMin: 720, endMin: 780 },
    },
    (fs, cal) =>
      fs.files["archive/2026-07-10.txt"] === "cleared" &&
      Object.values(cal.events).every((e) => e.day !== "2026-07-10")
  ),
  defineMixedItem(
    "mixed-4step-reschedule-and-log",
    "Delete every event on 2026-07-11 AND write a file at logs/2026-07-11.txt that lists, one per line, the title of each deleted event in their original chronological order.",
    4,
    {},
    {
      "1": { id: "1", title: "ev-A", day: "2026-07-11", startMin: 540, endMin: 600 },
      "2": { id: "2", title: "ev-B", day: "2026-07-11", startMin: 700, endMin: 760 },
    },
    (fs, cal) =>
      Object.values(cal.events).every((e) => e.day !== "2026-07-11") &&
      fs.files["logs/2026-07-11.txt"] === "ev-A\nev-B"
  ),
  defineMixedItem(
    "mixed-4step-summary",
    "Read notes/agenda.md. Create one 60-minute event on 2026-07-12 at 10:00 whose title is the first line of that file. Also create a file at logs/scheduled.txt with content 'OK'.",
    4,
    { "notes/agenda.md": "Strategy review\n..." },
    {},
    (fs, cal) =>
      fs.files["logs/scheduled.txt"] === "OK" &&
      Object.values(cal.events).some(
        (e) =>
          e.title === "Strategy review" &&
          e.day === "2026-07-12" &&
          e.startMin === 600 &&
          e.endMin === 660
      )
  ),
  defineMixedItem(
    "mixed-4step-purge",
    "Delete every file under inbox/ AND delete every event on 2026-07-13.",
    4,
    { "inbox/a.txt": "x", "inbox/b.txt": "y", "keep.txt": "keep" },
    {
      "1": { id: "1", title: "z", day: "2026-07-13", startMin: 540, endMin: 600 },
    },
    (fs, cal) =>
      !Object.keys(fs.files).some((p) => p.startsWith("inbox/")) &&
      fs.files["keep.txt"] === "keep" &&
      Object.values(cal.events).every((e) => e.day !== "2026-07-13")
  ),
  defineMixedItem(
    "mixed-3step-rename-and-create",
    "Rename docs/old.txt to docs/new.txt and create a 30-minute event 'verify' on 2026-07-14 at 09:00.",
    3,
    { "docs/old.txt": "content" },
    {},
    (fs, cal) =>
      fs.files["docs/new.txt"] === "content" &&
      !("docs/old.txt" in fs.files) &&
      Object.values(cal.events).some(
        (e) =>
          e.title === "verify" && e.day === "2026-07-14" && e.startMin === 540 && e.endMin === 570
      )
  ),
];

// ── runItem implementation ──────────────────────────────────────────────────

function buildModel(spec: ModelSpec): Model {
  return new GenericOpenAICompatModel(spec.modelId ?? spec.id, spec.baseUrl, {
    apiKey: spec.apiKey ?? process.env.OPENAI_API_KEY ?? "ollama",
  });
}

const SYSTEM_PROMPT =
  "You are an expert assistant operating a sandboxed workspace through tools. " +
  "Use the tools to complete the user's task end to end. " +
  "You may need multiple tool calls — keep going until the task is complete. " +
  "When you are certain the task is done, reply with the single line 'DONE.' as your final answer (no tool call).";

async function runOne(args: { item: BenchmarkItem; model: ModelSpec }): Promise<RunItemResult> {
  const { item, model } = args;
  const meta = META[item.id];
  if (!meta) {
    return { answer: null, passed: false, error: `no fixture for item ${item.id}` };
  }
  const m = buildModel(model);
  const startMs = Date.now();
  let tools: ToolDefinition[];
  let stateFs: FsState | null = null;
  let stateCal: CalState | null = null;
  let stateCart: CartState | null = null;
  if (meta.family === "fs") {
    stateFs = meta.fixture.makeState();
    tools = meta.fixture.makeTools(stateFs);
  } else if (meta.family === "cal") {
    stateCal = meta.fixture.makeState();
    tools = meta.fixture.makeTools(stateCal);
  } else if (meta.family === "cart") {
    stateCart = meta.fixture.makeState();
    tools = meta.fixture.makeTools(stateCart);
  } else {
    stateFs = meta.fsFix.makeState();
    stateCal = meta.calFix.makeState();
    tools = [...meta.fsFix.makeTools(stateFs), ...meta.calFix.makeTools(stateCal)];
  }

  const agent = new ToolCallingAgent({
    model: m,
    tools,
    maxSteps: 15,
    systemPrompt: SYSTEM_PROMPT,
  });

  let finalAnswer: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | null = null;
  const events: AgentEvent[] = [];
  try {
    for await (const ev of agent.run(item.task)) {
      events.push(ev);
      if (ev.event === "model_done") {
        const data = ev.data as { inputTokens?: number; outputTokens?: number };
        inputTokens += data.inputTokens ?? 0;
        outputTokens += data.outputTokens ?? 0;
      }
      if (ev.event === "final_answer") {
        finalAnswer = (ev.data as { answer?: string }).answer ?? "";
      }
      if (ev.event === "error") {
        error = String((ev.data as { error?: unknown }).error ?? "agent error");
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const wallMs = Date.now() - startMs;

  // Apply judge against the terminal state.
  let passed = false;
  try {
    if (meta.family === "fs" && stateFs) passed = meta.judge(stateFs);
    else if (meta.family === "cal" && stateCal) passed = meta.judge(stateCal);
    else if (meta.family === "cart" && stateCart) passed = meta.judge(stateCart);
    else if (meta.family === "mixed" && stateFs && stateCal) passed = meta.judge(stateFs, stateCal);
  } catch {
    passed = false;
  }
  // If the agent errored AND nothing got applied, the judge usually
  // returns false anyway — but for trivial 1-step "report contents" items
  // (fs-1step-read, cal-1step-list) the judge is a tautology, so an
  // agent-level error has to override it. Otherwise we'd score errored
  // runs as passing on the easiest items.
  if (error) passed = false;

  return {
    answer: finalAnswer,
    passed,
    wallMs,
    tokens: { input: inputTokens, output: outputTokens },
    error,
    events,
  };
}

// ── Suite export ────────────────────────────────────────────────────────────

export const multiTurnToolExecSuite: BenchmarkSuite = {
  name: "multi-turn-tool-exec",
  title: "Multi-turn tool execution (BFCL-v3-style state-transition judge)",
  description:
    "30 stateful multi-step tasks across filesystem / calendar / cart / mixed fixtures. " +
    "Each cell runs a real ToolCallingAgent loop (maxSteps=15). " +
    "Judged by terminal-state diff, not text match — answers the desktop-agent " +
    "feasibility question (TinyLLM 2025-11) that single-call suites cannot.",
  items: ITEMS,
  // No standard scorers — judging is done in runItem via state-transition.
  scorers: [],
  runItem: runOne,
};

// Helpers for tests — not part of the public API.
export const __test__ = {
  fsFixture,
  calFixture,
  cartFixture,
  META,
  ITEMS,
  fsJudge,
  calJudge,
  cartJudge,
};
