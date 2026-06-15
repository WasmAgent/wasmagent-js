/**
 * LocalModel — embedded llama.cpp adapter implementing {@link Model}.
 *
 * Why this file is small:
 *   - Streaming, retry, fallback, and grammar shaping are already handled
 *     by core (StreamEvent / RetryPolicy / FallbackModel) and our own
 *     {@link grammar} helpers. This file only translates between agentkit's
 *     `ModelMessage[] → AsyncGenerator<StreamEvent>` interface and
 *     node-llama-cpp's session-based API.
 *
 * Loading strategy:
 *   - We dynamically `await import("node-llama-cpp")` on first generate(),
 *     so the package can be installed without the native binding. If the
 *     binding is missing, we throw a {@link LocalModelDependencyError} with
 *     an actionable install hint.
 *   - Models are loaded lazily and cached per LocalModel instance. The
 *     LlamaContext is reused across generate() calls; sessions are created
 *     fresh per call to keep multi-turn isolation cheap.
 *
 * Capability reporting:
 *   - `localEndpoint: true`, `metered: false`, `supportsGrammar: true`,
 *     `cacheStrategy: "none"`. `contextWindow` is filled dynamically once
 *     the model is loaded (until then we expose the registry-declared value
 *     for `model:` aliases, or a conservative 4096 default for raw paths).
 */

import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
} from "@agentkit-js/core/models";
import { downloadGGUF, downloadUrl } from "./downloader.js";
import {
  buildResponseFormatSchema,
  buildToolCallSchema,
  buildToolPromptAddendum,
  extractTools,
  type ParsedToolCallOutput,
  parseToolCallOutput,
} from "./grammar.js";
import { getRegisteredModel, MODEL_REGISTRY } from "./registry.js";
import {
  LocalModelDependencyError,
  LocalModelError,
  type LocalModelOptions,
  type LocalModelSource,
} from "./types.js";

// node-llama-cpp's public surface — duck-typed so we don't take a hard
// dependency at type-check time. The peer is loaded via dynamic import.
interface LlamaModuleLike {
  getLlama(opts?: object): Promise<{
    loadModel(opts: { modelPath: string; gpuLayers?: number | "max" | "auto" }): Promise<{
      createContext(opts: { contextSize?: number; threads?: number }): Promise<LlamaContextLike>;
      readonly trainContextSize: number;
      readonly fileInfo?: { metadata?: Record<string, unknown> };
    }>;
  }>;
  LlamaChatSession: new (opts: {
    contextSequence: unknown;
    systemPrompt?: string;
  }) => LlamaChatSessionLike;
}

interface LlamaContextLike {
  getSequence(): unknown;
  readonly contextSize: number;
}

interface LlamaChatSessionLike {
  prompt(
    text: string,
    opts?: {
      onTextChunk?: (chunk: string) => void;
      grammar?: unknown;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      topK?: number;
      seed?: number;
      stopOnAbortSignal?: boolean;
    }
  ): Promise<string>;
  /**
   * Optional in older node-llama-cpp builds; present in 3.x. Releases the
   * underlying LlamaContextSequence so the next generate() can reuse it.
   * Without this, the second generate() throws "No sequences left" on a
   * default-sized (sequences=1) context — caught by real-machine cert run
   * 2026-06-12 (Qwen2.5-0.5B), single-call smoke didn't surface it.
   */
  dispose?(): void;
}

interface LlamaSequenceLike {
  dispose?(): void;
}

let _cached: LlamaModuleLike | null = null;
async function loadLlamaModule(): Promise<LlamaModuleLike> {
  if (_cached) return _cached;
  try {
    // node-llama-cpp is an optional peer; resolved at runtime so consumers
    // who never call generate() never load the native binding. We import via
    // a non-literal string so TypeScript doesn't try to resolve types at
    // compile time — peer may not be installed in downstream packages.
    const moduleName = "node-llama-cpp";
    const mod = (await import(moduleName)) as unknown as LlamaModuleLike;
    _cached = mod;
    return mod;
  } catch (err) {
    throw new LocalModelDependencyError(
      "node-llama-cpp is not installed.\n" +
        "  Install it with:  npm install node-llama-cpp\n" +
        "  (or: bun add node-llama-cpp / pnpm add node-llama-cpp)\n" +
        "  Then retry — @agentkit-js/model-local will pick it up automatically.",
      err
    );
  }
}

/**
 * Test seam — replaces the loader with a stub for unit tests.
 * @internal
 */
export function __setLlamaModuleForTests(mod: LlamaModuleLike | null): void {
  _cached = mod;
}

// ── LocalModel ────────────────────────────────────────────────────────────────

interface LoadedModel {
  modelPath: string;
  context: LlamaContextLike;
  llamaChat: new (opts: {
    contextSequence: unknown;
    systemPrompt?: string;
  }) => LlamaChatSessionLike;
  llama: { createGrammarForJsonSchema?: (schema: object) => Promise<unknown> | unknown };
  trainContextSize: number;
}

export class LocalModel implements Model {
  readonly providerId: string;
  readonly capabilities: ModelCapabilities;

  readonly #opts: LocalModelOptions;
  #loaded: LoadedModel | null = null;
  #loadingPromise: Promise<LoadedModel> | null = null;

  constructor(opts: LocalModelOptions) {
    if (!opts.source) {
      throw new LocalModelError(
        "LocalModel requires `source: { path | model | url }` — see @agentkit-js/model-local README"
      );
    }
    this.#opts = opts;

    this.providerId = opts.providerId ?? aliasFromSource(opts.source) ?? "local-llama";

    // Pre-fill capabilities from the registry when the source is a known alias.
    let contextWindow = 4096;
    if ("model" in opts.source) {
      const reg = MODEL_REGISTRY[opts.source.model];
      if (reg) contextWindow = reg.contextWindow;
    }
    this.capabilities = {
      localEndpoint: true,
      metered: false,
      supportsGrammar: true,
      cacheStrategy: "none",
      contextWindow,
    };
  }

  /**
   * Eagerly load the model. Optional — generate() will load on first call.
   * Useful for warm-up paths where you want the cost out of the way.
   */
  async load(): Promise<void> {
    await this.#ensureLoaded();
  }

  async *generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const loaded = await this.#ensureLoaded();
    const sysPrompt = extractSystemPrompt(messages, opts);
    const sequence = loaded.context.getSequence() as LlamaSequenceLike;
    const sessionOpts: { contextSequence: unknown; systemPrompt?: string } = {
      contextSequence: sequence,
    };
    if (sysPrompt !== undefined) sessionOpts.systemPrompt = sysPrompt;
    const session = new loaded.llamaChat(sessionOpts);

    // Whether we yielded events successfully — used to decide whether to swallow
    // a sequence-pool exhaustion error in the cleanup path. The session/sequence
    // MUST be released back to the pool on every exit (success OR error),
    // otherwise the next generate() throws "No sequences left" — surfaced by
    // the real-machine cert run on Qwen2.5-0.5B (2026-06-12).
    try {
      yield* this.#runGeneration(session, loaded, messages, opts);
    } finally {
      try {
        session.dispose?.();
      } catch {
        // Disposal must never mask the upstream error.
      }
      try {
        sequence.dispose?.();
      } catch {
        // Same.
      }
    }
  }

  async *#runGeneration(
    session: LlamaChatSessionLike,
    loaded: LoadedModel,
    messages: ModelMessage[],
    opts: GenerateOptions
  ): AsyncGenerator<StreamEvent> {
    // Decide grammar mode: tool-calling > responseFormat > free-form.
    const tools = extractTools(opts.tools);
    const enableGrammar = this.#opts.enableGrammar !== false;

    let grammar: unknown;
    let promptAddendum = "";
    let mode: "tool" | "json" | "free" = "free";

    if (enableGrammar && tools.length > 0) {
      mode = "tool";
      const schema = buildToolCallSchema(tools);
      promptAddendum = buildToolPromptAddendum(tools);
      grammar = await tryCreateGrammar(loaded.llama, schema);
    } else if (enableGrammar && opts.responseFormat) {
      mode = "json";
      const schema = buildResponseFormatSchema(opts.responseFormat);
      grammar = await tryCreateGrammar(loaded.llama, schema);
    }

    const userText = renderMessagesAsPrompt(messages, promptAddendum);

    if (mode === "tool" || mode === "json") {
      // Grammar-constrained: we get the full output once, then parse.
      // Streaming text deltas are still emitted for UX (tokens flow as they
      // arrive), but a `tool_call` is emitted only after parsing.
      let collected = "";
      const promptOpts: Record<string, unknown> = {
        onTextChunk: (chunk: string) => {
          collected += chunk;
        },
      };
      if (grammar !== undefined) promptOpts.grammar = grammar;
      const numericFields = this.#numericSamplingFields(opts);
      Object.assign(promptOpts, numericFields);

      try {
        await session.prompt(userText, promptOpts);
      } catch (err) {
        // Token-budget truncation → one retry with bigger budget; otherwise surface.
        if (isTruncation(err) && (promptOpts.maxTokens as number | undefined) !== undefined) {
          collected = "";
          promptOpts.maxTokens = ((promptOpts.maxTokens as number) ?? 512) * 2;
          await session.prompt(userText, promptOpts);
        } else {
          throw err;
        }
      }

      const parsed =
        mode === "tool" ? parseToolCallOutput(collected) : ({} as ParsedToolCallOutput);

      if (mode === "tool" && parsed.toolCall) {
        yield {
          type: "tool_call",
          toolCall: {
            type: "tool_use",
            id: `local_${Date.now().toString(36)}`,
            name: parsed.toolCall.name,
            input: parsed.toolCall.input,
          },
        };
        yield { type: "stop", stopReason: "tool_use" };
      } else if (mode === "tool" && parsed.finalAnswer !== undefined) {
        yield { type: "text_delta", delta: parsed.finalAnswer };
        yield { type: "stop", stopReason: "end_turn" };
      } else if (mode === "json") {
        yield { type: "text_delta", delta: collected };
        yield { type: "stop", stopReason: "end_turn" };
      } else {
        // Tool mode but parser bailed — emit raw text and let caller decide.
        yield { type: "text_delta", delta: collected };
        yield { type: "stop", stopReason: "end_turn" };
      }
      yield {
        type: "usage",
        usage: this.#estimateUsage(messages, collected),
      };
      return;
    }

    // Free-form streaming.
    const queue: string[] = [];
    let done = false;
    let resolveNext: (() => void) | null = null;
    const promptOpts: Record<string, unknown> = {
      onTextChunk: (chunk: string) => {
        queue.push(chunk);
        const r = resolveNext;
        resolveNext = null;
        r?.();
      },
    };
    Object.assign(promptOpts, this.#numericSamplingFields(opts));

    const finalPromise = session
      .prompt(userText, promptOpts)
      .then(
        (full: string) => ({ full, error: null as unknown }),
        (error: unknown) => ({ full: "", error })
      )
      .finally(() => {
        done = true;
        const r = resolveNext;
        resolveNext = null;
        r?.();
      });

    let totalText = "";
    while (true) {
      while (queue.length > 0) {
        const chunk = queue.shift() as string;
        totalText += chunk;
        yield { type: "text_delta", delta: chunk };
      }
      if (done) break;
      await new Promise<void>((res) => {
        resolveNext = res;
      });
    }
    const result = await finalPromise;
    if (result.error) throw result.error;
    yield { type: "stop", stopReason: "end_turn" };
    yield { type: "usage", usage: this.#estimateUsage(messages, totalText) };
  }

  // ── private ─────────────────────────────────────────────────────────────────

  async #ensureLoaded(): Promise<LoadedModel> {
    if (this.#loaded) return this.#loaded;
    if (this.#loadingPromise) return this.#loadingPromise;
    this.#loadingPromise = this.#doLoad();
    try {
      this.#loaded = await this.#loadingPromise;
      return this.#loaded;
    } finally {
      this.#loadingPromise = null;
    }
  }

  async #doLoad(): Promise<LoadedModel> {
    const path = await this.#resolvePath();
    const mod = await loadLlamaModule();
    const llama = await mod.getLlama();
    const loadOpts: { modelPath: string; gpuLayers?: number | "max" | "auto" } = {
      modelPath: path,
    };
    if (this.#opts.gpuLayers !== undefined) loadOpts.gpuLayers = this.#opts.gpuLayers;
    const llamaModel = await llama.loadModel(loadOpts);
    const ctxOpts: { contextSize?: number; threads?: number } = {};
    if (this.#opts.contextSize !== undefined) ctxOpts.contextSize = this.#opts.contextSize;
    if (this.#opts.threads !== undefined) ctxOpts.threads = this.#opts.threads;
    const context = await llamaModel.createContext(ctxOpts);

    // Refine reported context window once we know the truth.
    (this.capabilities as { contextWindow?: number }).contextWindow =
      context.contextSize ?? llamaModel.trainContextSize ?? this.capabilities.contextWindow;

    return {
      modelPath: path,
      context,
      llamaChat: mod.LlamaChatSession,
      llama: llama as unknown as LoadedModel["llama"],
      trainContextSize: llamaModel.trainContextSize,
    };
  }

  async #resolvePath(): Promise<string> {
    const src = this.#opts.source;
    if ("path" in src) return src.path;
    if ("model" in src) {
      const reg = getRegisteredModel(src.model);
      const downloadOpts: Parameters<typeof downloadGGUF>[1] = {};
      if (this.#opts.cacheDir !== undefined) downloadOpts.cacheDir = this.#opts.cacheDir;
      if (this.#opts.mirror !== undefined) downloadOpts.mirror = this.#opts.mirror;
      if (this.#opts.onDownloadProgress !== undefined)
        downloadOpts.onProgress = this.#opts.onDownloadProgress;
      const result = await downloadGGUF(reg, downloadOpts);
      return result.path;
    }
    if ("url" in src) {
      const downloadOpts: Parameters<typeof downloadUrl>[1] = {};
      if (this.#opts.cacheDir !== undefined) downloadOpts.cacheDir = this.#opts.cacheDir;
      if (src.expectedSha256 !== undefined) downloadOpts.expectedSha256 = src.expectedSha256;
      if (this.#opts.onDownloadProgress !== undefined)
        downloadOpts.onProgress = this.#opts.onDownloadProgress;
      const result = await downloadUrl(src.url, downloadOpts);
      return result.path;
    }
    throw new LocalModelError("LocalModel.source must be one of {path, model, url}");
  }

  #numericSamplingFields(opts: GenerateOptions): Record<string, number> {
    const fields: Record<string, number> = {};
    const t = opts.temperature ?? this.#opts.temperature;
    if (t !== undefined) fields.temperature = t;
    const p = opts.topP ?? this.#opts.topP;
    if (p !== undefined) fields.topP = p;
    if (this.#opts.topK !== undefined) fields.topK = this.#opts.topK;
    if (opts.maxTokens !== undefined) fields.maxTokens = opts.maxTokens;
    if (opts.seed !== undefined) fields.seed = opts.seed;
    return fields;
  }

  #estimateUsage(messages: ModelMessage[], output: string) {
    // We don't have direct token counts from node-llama-cpp here without
    // poking at the tokenizer; use the same heuristic as core.estimateTokens.
    let inputChars = 0;
    for (const m of messages) {
      if (typeof m.content === "string") inputChars += m.content.length;
      else for (const b of m.content) inputChars += approxBlockChars(b);
    }
    const inputTokens = Math.max(1, Math.ceil(inputChars / 4));
    const outputTokens = Math.max(1, Math.ceil(output.length / 4));
    return { inputTokens, outputTokens };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function aliasFromSource(src: LocalModelSource): string | undefined {
  if ("model" in src) return `local-${src.model}`;
  return undefined;
}

function extractSystemPrompt(messages: ModelMessage[], _opts: GenerateOptions): string | undefined {
  // node-llama-cpp's chat session takes one systemPrompt; concatenate any leading
  // system messages.
  const sysPieces: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") break;
    if (typeof m.content === "string") sysPieces.push(m.content);
    else
      for (const b of m.content) {
        if (b.type === "text") sysPieces.push(b.text);
      }
  }
  return sysPieces.length > 0 ? sysPieces.join("\n\n") : undefined;
}

/** Render non-system messages into a single prompt string for the chat session. */
export function renderMessagesAsPrompt(
  messages: ModelMessage[],
  toolPromptAddendum: string
): string {
  const lines: string[] = [];
  let leadingSystemConsumed = false;
  for (const m of messages) {
    if (m.role === "system" && !leadingSystemConsumed) {
      // System messages are handled by extractSystemPrompt() — skip the leading
      // run, but still render mid-conversation system messages as labelled text.
      continue;
    }
    leadingSystemConsumed = true;
    const text = renderContent(m.content);
    if (m.role === "user") lines.push(text);
    else if (m.role === "assistant") lines.push(`[assistant] ${text}`);
    else if (m.role === "tool") lines.push(`[tool result] ${text}`);
    else lines.push(`[system] ${text}`);
  }
  if (toolPromptAddendum) lines.push("", toolPromptAddendum);
  return lines.join("\n");
}

function renderContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "tool_result") parts.push(b.content);
    else if (b.type === "tool_use") parts.push(`[tool_use:${b.name}]${JSON.stringify(b.input)}`);
    else if (b.type === "thinking") parts.push(`[thinking]${b.thinking}`);
  }
  return parts.join("\n");
}

function approxBlockChars(b: import("@agentkit-js/core/models").ContentBlock): number {
  if (b.type === "text") return b.text.length;
  if (b.type === "tool_result") return b.content.length;
  if (b.type === "tool_use") return JSON.stringify(b.input).length;
  if (b.type === "thinking") return b.thinking.length;
  return 0;
}

async function tryCreateGrammar(
  llama: LoadedModel["llama"],
  schema: object
): Promise<unknown | undefined> {
  if (typeof llama.createGrammarForJsonSchema !== "function") {
    // Engine without grammar support — return undefined so caller falls back
    // to free-form sampling. The prompt addendum still describes the shape.
    return undefined;
  }
  try {
    const result = await llama.createGrammarForJsonSchema(schema);
    return result;
  } catch {
    return undefined;
  }
}

function isTruncation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /max(?:_)?tokens|truncat|aborted|context/i.test(msg);
}
