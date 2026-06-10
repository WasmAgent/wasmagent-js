import type { Embedder } from "@agentkit-js/core";

export interface HttpEmbedderOpts {
  /** Embedding endpoint URL. Default: OpenAI's. */
  baseUrl?: string;
  /** Endpoint path. Default: "/v1/embeddings". */
  path?: string;
  /** API key (sent as `Bearer <key>`). */
  apiKey: string;
  /** Embedding model name, e.g. "text-embedding-3-small", "voyage-3", "embed-english-v3.0". */
  model: string;
  /** Override the request shape. Default: OpenAI-compatible `{model, input}`. */
  buildRequest?: (input: string | string[], model: string) => unknown;
  /** Override the response parser. Default: OpenAI-compatible `data[].embedding`. */
  parseResponse?: (data: unknown) => number[][];
  /** Extra headers (e.g. `OpenAI-Organization`). */
  headers?: Record<string, string>;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
}

const defaultParse = (data: unknown): number[][] => {
  const r = data as OpenAiEmbeddingResponse;
  return (r.data ?? []).map((d) => d.embedding);
};

const defaultBuild = (input: string | string[], model: string): unknown => ({ model, input });

/**
 * Generic embedder backed by any OpenAI-compatible HTTP embeddings API.
 *
 * Works with: OpenAI, Voyage AI, Cohere (with `parseResponse` override),
 * any local server exposing /v1/embeddings (Ollama, vLLM, LM Studio, etc.).
 *
 * @example
 *   const embedder = new HttpEmbedder({
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     model: "text-embedding-3-small",
 *   });
 *   const v = await embedder.embed("Hello world");
 */
export class HttpEmbedder implements Embedder {
  readonly #opts: Required<Pick<HttpEmbedderOpts, "baseUrl" | "path" | "model" | "apiKey">> &
    Pick<HttpEmbedderOpts, "buildRequest" | "parseResponse" | "headers">;

  constructor(opts: HttpEmbedderOpts) {
    this.#opts = {
      baseUrl: opts.baseUrl ?? "https://api.openai.com",
      path: opts.path ?? "/v1/embeddings",
      apiKey: opts.apiKey,
      model: opts.model,
      buildRequest: opts.buildRequest ?? defaultBuild,
      parseResponse: opts.parseResponse ?? defaultParse,
      ...(opts.headers !== undefined && { headers: opts.headers }),
    };
  }

  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedBatch([text]);
    return vectors[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.#opts.baseUrl}${this.#opts.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#opts.apiKey}`,
        "Content-Type": "application/json",
        ...(this.#opts.headers ?? {}),
      },
      body: JSON.stringify((this.#opts.buildRequest ?? defaultBuild)(texts, this.#opts.model)),
    });

    if (!resp.ok) {
      throw new Error(`HttpEmbedder: HTTP ${resp.status} ${await resp.text().catch(() => "")}`);
    }

    const data = await resp.json();
    return (this.#opts.parseResponse ?? defaultParse)(data);
  }
}

/** Alias for the most common case: OpenAI-style embeddings. */
export const OpenAiCompatibleEmbedder = HttpEmbedder;
