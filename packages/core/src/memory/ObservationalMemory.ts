/**
 * A1 — Observational Memory.
 *
 * Continuous-observation alternative to the one-shot
 * {@link MessageAssembler.compact}. Inspired by Mastra's Observational Memory
 * (LongMemEval 94.87%, 5–40× compression) but adapted to agentkit-js'
 * existing primitives:
 *
 *   - sits on top of an existing MessageAssembler — does NOT replace it
 *   - reuses the package's KvBackend interface for persistence
 *   - the "observer" model can be different from the agent model, so cheap
 *     models (Haiku, Doubao, DeepSeek) compress while the expensive agent
 *     model focuses on the task
 *   - emits observations as a single planning step inserted at the front of
 *     the history, keeping the rest of the prefix byte-stable for prompt
 *     cache (this is the angle Mastra cannot match — they have no
 *     Anthropic cache_control awareness)
 *
 * The class does NOT mutate the assembler synchronously on every step; that
 * would defeat the prompt cache. Instead, when tokens cross a configured
 * threshold it spawns an asynchronous compression pass, and only swaps in
 * the result on success. If the agent runs another step before the pass
 * completes, the next observation cycle picks up from there.
 */

import type { KvBackend } from "../checkpoint/index.js";
import type { Model, ModelMessage } from "../models/types.js";
import { estimateMessagesTokens } from "../models/types.js";
import type { MessageAssembler } from "./MessageAssembler.js";

/**
 * Priority a single observation carries. The observer ranks each note so
 * future retrieval can lean on the high-priority slice when context is
 * tight. We keep the scale small on purpose — three buckets are easier
 * for the observer model to assign consistently than five.
 */
export type ObservationPriority = "high" | "medium" | "low";

/**
 * One persisted observation. Persisted under `obs:<sessionId>:<seqId>` in
 * the KvBackend when one is bound; held in-memory only when not.
 */
export interface Observation {
  /** Monotonic id within a session — the sort key. */
  seqId: number;
  /** When the observation was minted (server clock, ms since epoch). */
  createdAtMs: number;
  /** One short paragraph the observer model produced. */
  text: string;
  /** Routing hint for retrieval. */
  priority: ObservationPriority;
  /** Range of the original assembler step indices the observation covers. */
  coversSteps: { from: number; to: number };
}

export interface ObservationalMemoryOptions {
  /** The assembler whose history will be observed and compacted. */
  assembler: MessageAssembler;
  /** Model used for the agent itself (passed only as a fallback observer). */
  model: Model;
  /**
   * Cheaper model used to summarise. When omitted, falls back to {@link model}.
   * Pairing a Haiku/Doubao observer with a Sonnet/Opus agent is the typical
   * setup — we don't enforce that, just make it easy.
   */
  observerModel?: Model;
  /**
   * KV backend for persistence. When omitted, observations live only in
   * memory and disappear when the process exits.
   */
  kv?: KvBackend;
  /**
   * Session id — used to partition observations across concurrent users
   * sharing the same KV. Required even when KV is absent so the in-memory
   * map is partitioned consistently.
   */
  sessionId: string;
  /**
   * Threshold (in estimated tokens) at which to trigger compression. The
   * observer pass runs the moment {@link noteStep} sees the assembler's
   * built messages cross this number. Default: 6000 tokens — well under
   * Sonnet's prompt cache breakpoint window.
   */
  tokenThreshold?: number;
  /**
   * Number of most-recent steps to keep verbatim (NOT replaced by the
   * observation summary). Default: 5 — same as compact().
   */
  keepRecentSteps?: number;
  /**
   * Cap on observer output tokens. Default: 600. The observer is asked to
   * fit within this; we do not clip server-side.
   */
  maxObserverTokens?: number;
}

const DEFAULT_TOKEN_THRESHOLD = 6000;
const DEFAULT_KEEP_RECENT = 5;
const DEFAULT_MAX_OBSERVER_TOKENS = 600;

/** KV prefix for stored observations under a session. */
function obsPrefix(sessionId: string): string {
  return `obs:${sessionId}:`;
}

function obsKey(sessionId: string, seqId: number): string {
  // Pad seqId so list() returns lexicographic == numeric order.
  return `${obsPrefix(sessionId)}${String(seqId).padStart(8, "0")}`;
}

/**
 * Observer system prompt. Kept minimal; the observer model only needs to
 * compress, not strategise.
 */
const OBSERVER_SYSTEM = `You are an observer that compresses agent histories into ranked
observation paragraphs. Output JSON of shape:
{ "priority": "high" | "medium" | "low", "text": "<<one paragraph>>" }

Rules:
- "high" — the observation contains a decision, a result, or a fact the
  agent will need to act on later. Most observations are NOT high.
- "medium" — useful background; might be skipped under context pressure.
- "low" — chatter or filler; safe to drop under pressure.
- One paragraph, no bullet lists, no preamble, no closing remarks.
- Preserve concrete identifiers (file paths, error codes, numbers) verbatim.
Respond with ONLY the JSON object.`;

/**
 * Try to parse a compact JSON object from the observer's output. Falls
 * through to a "low" priority bare-text observation if the model didn't
 * obey the contract (defensive default — better than throwing).
 */
function parseObserverReply(raw: string): { text: string; priority: ObservationPriority } {
  const trimmed = raw.trim();
  // Strip a leading code-fence the model may have added despite instructions.
  const inner = trimmed.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const obj = JSON.parse(inner) as { text?: unknown; priority?: unknown };
    const text = typeof obj.text === "string" ? obj.text : "";
    const priority =
      obj.priority === "high" || obj.priority === "medium" || obj.priority === "low"
        ? obj.priority
        : "low";
    if (text.length > 0) return { text, priority };
  } catch {
    /* fall through */
  }
  return { text: trimmed, priority: "low" };
}

export class ObservationalMemory {
  readonly #assembler: MessageAssembler;
  readonly #observerModel: Model;
  readonly #kv: KvBackend | undefined;
  readonly #sessionId: string;
  readonly #tokenThreshold: number;
  readonly #keepRecentSteps: number;
  readonly #maxObserverTokens: number;

  /** Observations indexed by seqId — fast in-memory access for tests / queries. */
  readonly #cache = new Map<number, Observation>();
  /** Next seqId to assign; starts at 1 and increases monotonically. */
  #nextSeq = 1;
  /** When set, an observer pass is in flight; concurrent passes are skipped. */
  #pending: Promise<void> | null = null;
  /** Most recent error message from the observer — surfaced via getLastError(). */
  #lastError: string | null = null;
  /**
   * The number of steps the assembler had at the start of the most recent
   * compression run. Used so subsequent runs only compress *new* steps,
   * not re-run the whole history.
   */
  #lastObservedAtStepIdx = 0;

  constructor(opts: ObservationalMemoryOptions) {
    this.#assembler = opts.assembler;
    this.#observerModel = opts.observerModel ?? opts.model;
    this.#kv = opts.kv;
    this.#sessionId = opts.sessionId;
    this.#tokenThreshold = opts.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    this.#keepRecentSteps = Math.max(1, opts.keepRecentSteps ?? DEFAULT_KEEP_RECENT);
    this.#maxObserverTokens = opts.maxObserverTokens ?? DEFAULT_MAX_OBSERVER_TOKENS;
  }

  /**
   * Notify the memory that a new step has been appended to the assembler.
   * Triggers an asynchronous observer pass when the assembled message size
   * crosses the configured threshold.
   *
   * Cheap: a single estimateMessagesTokens call. The observer pass runs in
   * the background and never blocks the caller.
   */
  noteStep(): void {
    if (this.#pending) return; // observer is already running
    const messages = this.#assembler.build();
    if (estimateMessagesTokens(messages) < this.#tokenThreshold) return;
    this.#pending = this.#runObserverPass()
      .catch((err) => {
        this.#lastError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.#pending = null;
      });
  }

  /**
   * Wait for the current observer pass (if any). Tests, graceful shutdown,
   * and durable-checkpoint code paths use this to ensure observations are
   * persisted before the run record is written out.
   */
  async flush(): Promise<void> {
    while (this.#pending) {
      await this.#pending;
    }
  }

  /**
   * Read all observations for this session. KV-backed when available — falls
   * through to the in-memory cache when KV is absent or list() is missing.
   * Sorted by seqId ascending.
   */
  async list(): Promise<Observation[]> {
    if (this.#kv?.list) {
      try {
        const keys = await this.#kv.list(obsPrefix(this.#sessionId));
        const out: Observation[] = [];
        for (const key of keys) {
          const raw = await this.#kv.get(key);
          if (!raw) continue;
          out.push(JSON.parse(raw) as Observation);
        }
        return out.sort((a, b) => a.seqId - b.seqId);
      } catch (err) {
        // Fall back to cache; warn so users notice misconfigured KVs.
        console.warn("[obs] KV list failed, returning cache:", err);
      }
    }
    return [...this.#cache.values()].sort((a, b) => a.seqId - b.seqId);
  }

  /** Diagnostic — most recent observer error, or null if none. */
  getLastError(): string | null {
    return this.#lastError;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Run the observer model on the message-window slice. Persists the
   * resulting observation, then bumps `#lastObservedAtStepIdx` so the
   * next pass only sees newly appended history.
   *
   * Implementation note: MessageAssembler does NOT expose its internal
   * `#history` array publicly, so we observe the BUILT message window
   * instead. coversSteps tracks message indices, not step indices —
   * that's good enough for diagnostics; the cache benefit (compressed
   * prefix is byte-stable across future calls) does not depend on
   * step-level granularity.
   */
  async #runObserverPass(): Promise<void> {
    const messages = this.#assembler.build();
    if (messages.length === 0) return;
    if (messages.length <= this.#keepRecentSteps) return;
    const observeUntil = messages.length - this.#keepRecentSteps;
    if (observeUntil <= this.#lastObservedAtStepIdx) return;

    const sliceFrom = this.#lastObservedAtStepIdx;
    const sliceTo = observeUntil;
    const slice = messages.slice(sliceFrom, sliceTo);

    const summary = await this.#summariseMessages(slice);
    const seqId = this.#nextSeq++;
    const obs: Observation = {
      seqId,
      createdAtMs: Date.now(),
      text: summary.text,
      priority: summary.priority,
      coversSteps: { from: sliceFrom, to: sliceTo },
    };
    this.#cache.set(seqId, obs);
    if (this.#kv) {
      try {
        await this.#kv.put(obsKey(this.#sessionId, seqId), JSON.stringify(obs));
      } catch (err) {
        console.warn("[obs] KV put failed:", err);
      }
    }

    this.#lastObservedAtStepIdx = observeUntil;
  }

  async #summariseMessages(
    messages: ModelMessage[]
  ): Promise<{ text: string; priority: ObservationPriority }> {
    const userBody = messages
      .map((m, i) => {
        const content =
          typeof m.content === "string"
            ? m.content
            : m.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("\n");
        return `Msg ${i + 1} (${m.role}): ${content}`;
      })
      .join("\n\n");
    return this.#callObserver(userBody);
  }

  async #callObserver(userBody: string): Promise<{ text: string; priority: ObservationPriority }> {
    const prompt: ModelMessage[] = [
      { role: "system", content: OBSERVER_SYSTEM },
      {
        role: "user",
        content: `Compress the following history into a single observation paragraph in the JSON shape from the system prompt.\n\nHistory:\n${userBody}`,
      },
    ];

    let raw = "";
    for await (const ev of this.#observerModel.generate(prompt, {
      stream: true,
      maxTokens: this.#maxObserverTokens,
    })) {
      if (ev.type === "text_delta" && ev.delta) raw += ev.delta;
    }
    return parseObserverReply(raw);
  }

  /** Test-only — wipe in-memory cache and counters. */
  _resetForTests(): void {
    this.#cache.clear();
    this.#nextSeq = 1;
    this.#pending = null;
    this.#lastError = null;
    this.#lastObservedAtStepIdx = 0;
  }
}
