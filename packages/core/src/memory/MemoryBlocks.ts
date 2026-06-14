/**
 * MemoryBlocks — Letta-style editable in-context state.
 *
 * Each block is a labelled, char-bounded piece of state the agent can read
 * (always visible in the conversation context) and edit (via the
 * `core_memory_append` / `core_memory_replace` tools below). Typical
 * blocks: `persona` (who the agent is), `human` (who the user is),
 * `task_state` (what the agent is in the middle of doing).
 *
 * ## Design choice — render position
 *
 * Letta's original MemGPT design (2023, paper arXiv:2310.08560) renders
 * core memory inside the system prompt. That predates 2024-era
 * prefix-caching: rewriting the system prompt invalidates the entire
 * cached prefix on Anthropic / Bedrock / OpenAI. Editing core memory
 * mid-run would then cost a full prompt re-tokenization on the very
 * next call, every call.
 *
 * agentkit-js renders blocks in a separate `user`-role message
 * immediately AFTER the cached system message — same shape and
 * placement as the existing `scratchpad` slot in MessageAssembler
 * (`packages/core/src/memory/MessageAssembler.ts:121-126`). This:
 *
 *   - keeps the system prefix byte-stable for prompt cache (B1)
 *   - lets blocks change freely without invalidating the cached prefix
 *   - matches the assembler's existing scratchpad render contract, so
 *     the only delta vs scratchpad is "scratchpad is one string;
 *     blocks are N labelled strings"
 *
 * The trade-off: blocks are not part of the system message, so they are
 * not "permanent agent identity" the way Letta paints them. Treat them
 * as agent working state, refreshed per-run by the application or by
 * the agent itself using the tools below.
 *
 * ## Sizing
 *
 * Each block has a `charLimit`. Append/replace operations clip at the
 * limit (replace truncates from the left; append rejects with an
 * error so the agent learns the constraint). Default 2000 chars per
 * block, default 5 blocks max — keeps total core-memory budget under
 * ~10K chars (~2.5K tokens) so it stays a small constant overhead even
 * on long runs.
 */

import type { ToolDefinition } from "../tools/types.js";
import { z } from "zod";

export interface MemoryBlock {
  /**
   * Stable identifier the agent uses to read / append / replace this block.
   * Lowercase, snake_case recommended (no enforcement; the tool layer
   * passes the literal string through to the storage map).
   */
  label: string;
  /** Current contents of the block. Must satisfy `charLimit`. */
  value: string;
  /**
   * Hard cap on `value.length`. Blocks rendered into context contribute
   * this many chars worst-case; budget accordingly. Default 2000.
   */
  charLimit?: number;
  /**
   * Optional human description of what this block is for. Rendered in
   * the assembled message so the agent knows WHEN to write here vs.
   * other blocks. Keep short (~80 chars).
   */
  description?: string;
}

const DEFAULT_CHAR_LIMIT = 2000;
const DEFAULT_MAX_BLOCKS = 5;

/**
 * Mutable container for a small set of named memory blocks.
 *
 * One instance per agent run / session. Pass to `MessageAssembler` via
 * the optional `memoryBlocks` config field; the assembler renders them
 * on every `build()` (cheap — just reads the current `value` of each
 * block and concatenates).
 *
 * Mutate via `append()` / `replace()` directly from application code,
 * or via the tools returned by `coreMemoryTools(blocks)` from inside
 * the agent loop.
 */
export class MemoryBlockSet {
  #blocks: Map<string, MemoryBlock> = new Map();
  readonly #maxBlocks: number;

  constructor(initial: MemoryBlock[] = [], opts: { maxBlocks?: number } = {}) {
    this.#maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
    for (const b of initial) this.#install(b);
  }

  /** All blocks in insertion order. */
  list(): MemoryBlock[] {
    return [...this.#blocks.values()];
  }

  /** Get one block; undefined if no such label. */
  get(label: string): MemoryBlock | undefined {
    return this.#blocks.get(label);
  }

  /** Number of blocks currently installed. */
  get size(): number {
    return this.#blocks.size;
  }

  /**
   * Install a new block (or overwrite an existing one's value + limit).
   * Throws if installing the block would exceed `maxBlocks` AND the
   * label is new.
   */
  install(block: MemoryBlock): void {
    this.#install(block);
  }

  /**
   * Append text to a block. Returns an error string if the result would
   * exceed `charLimit` — the agent sees this and learns to either
   * `replace` or shorten its append.
   */
  append(label: string, text: string): { ok: true } | { ok: false; error: string } {
    const block = this.#blocks.get(label);
    if (!block) return { ok: false, error: `no block with label '${label}'` };
    const limit = block.charLimit ?? DEFAULT_CHAR_LIMIT;
    if (block.value.length + text.length > limit) {
      return {
        ok: false,
        error: `appending ${text.length} chars to block '${label}' would exceed charLimit ${limit} (current size ${block.value.length})`,
      };
    }
    block.value = block.value + text;
    return { ok: true };
  }

  /**
   * Replace a block's value entirely. If `text.length > charLimit`,
   * truncates from the LEFT (keeping the most recent text). The
   * truncation choice is deliberate: replace is typically used for
   * "summarise the last N events", and the most recent context is
   * usually more relevant than the oldest.
   */
  replace(label: string, text: string): { ok: true; truncated: boolean } | { ok: false; error: string } {
    const block = this.#blocks.get(label);
    if (!block) return { ok: false, error: `no block with label '${label}'` };
    const limit = block.charLimit ?? DEFAULT_CHAR_LIMIT;
    if (text.length > limit) {
      block.value = text.slice(text.length - limit);
      return { ok: true, truncated: true };
    }
    block.value = text;
    return { ok: true, truncated: false };
  }

  /**
   * Render the block set into a single user-role message body. Returns
   * empty string when there are no blocks — caller should skip
   * inserting an empty message in that case.
   *
   * Format is deliberately compact: each block on its own line, prefixed
   * with its label in `[brackets]`. Description (if any) is rendered as
   * an italic-style hint after the label. The entire payload is wrapped
   * in `<core_memory>` / `</core_memory>` so the model can be told
   * (via system prompt) "anything inside core_memory is editable state
   * you maintain across turns".
   */
  render(): string {
    if (this.#blocks.size === 0) return "";
    const lines: string[] = ["<core_memory>"];
    for (const b of this.#blocks.values()) {
      const desc = b.description ? ` (${b.description})` : "";
      lines.push(`[${b.label}]${desc}`);
      lines.push(b.value);
      lines.push("");
    }
    lines.push("</core_memory>");
    return lines.join("\n");
  }

  #install(block: MemoryBlock): void {
    if (!this.#blocks.has(block.label) && this.#blocks.size >= this.#maxBlocks) {
      throw new Error(
        `MemoryBlockSet: cannot add block '${block.label}': max ${this.#maxBlocks} blocks reached`,
      );
    }
    const limit = block.charLimit ?? DEFAULT_CHAR_LIMIT;
    if (block.value.length > limit) {
      throw new Error(
        `MemoryBlockSet: initial value for '${block.label}' (${block.value.length} chars) exceeds charLimit ${limit}`,
      );
    }
    this.#blocks.set(block.label, { ...block, charLimit: limit });
  }
}

/**
 * Build the two tools that let an agent edit its own core memory:
 *
 *   - `core_memory_append(label, text)` — non-destructive add to a block
 *   - `core_memory_replace(label, text)` — overwrite block contents
 *
 * Mirrors Letta's tool surface (`core_memory_append` /
 * `core_memory_replace` in letta-ai/letta `letta/services/`), so an
 * agent that learned the Letta API works here unchanged.
 *
 * Both tools are `readOnly: false, idempotent: false` — their effect
 * persists into the next render of the message assembler. They do NOT
 * write to any external store; if the application wants persistence
 * across runs, snapshot `blocks.list()` to a `KvBackend` between runs
 * (or use `StructuredMemory` for cross-session facts).
 */
export function coreMemoryTools(blocks: MemoryBlockSet): ToolDefinition[] {
  const labelArg = z.string().min(1);
  const textArg = z.string();

  const appendTool: ToolDefinition<{ label: string; text: string }, { ok: boolean; message: string }> = {
    name: "core_memory_append",
    description:
      "Append text to a labelled core-memory block. Use to add new observations or facts " +
      "without losing prior content. Errors if the result would exceed the block's charLimit.",
    inputSchema: z.object({ label: labelArg, text: textArg }),
    outputSchema: z.object({ ok: z.boolean(), message: z.string() }),
    readOnly: false,
    idempotent: false,
    async forward({ label, text }) {
      const r = blocks.append(label, text);
      if (r.ok) return { ok: true, message: `appended to '${label}'` };
      return { ok: false, message: r.error };
    },
  };

  const replaceTool: ToolDefinition<{ label: string; text: string }, { ok: boolean; message: string; truncated: boolean }> = {
    name: "core_memory_replace",
    description:
      "Replace the contents of a labelled core-memory block. Overwrites prior content. " +
      "Returns truncated:true if the new text was longer than the block's charLimit and was clipped.",
    inputSchema: z.object({ label: labelArg, text: textArg }),
    outputSchema: z.object({ ok: z.boolean(), message: z.string(), truncated: z.boolean() }),
    readOnly: false,
    idempotent: false,
    async forward({ label, text }) {
      const r = blocks.replace(label, text);
      if (r.ok) {
        return {
          ok: true,
          message: `replaced '${label}'${r.truncated ? " (truncated to charLimit)" : ""}`,
          truncated: r.truncated,
        };
      }
      return { ok: false, message: r.error, truncated: false };
    },
  };

  return [appendTool, replaceTool];
}
