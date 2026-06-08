import { describe, it, expect } from "vitest";
import { FallbackModel } from "./FallbackModel.js";
import type { Model, StreamEvent } from "./types.js";

function mockModel(responses: Array<{ events?: StreamEvent[]; error?: Error }>): Model {
  let callCount = 0;
  return {
    providerId: `mock-${Math.random().toString(36).slice(2)}`,
    async *generate(): AsyncGenerator<StreamEvent> {
      const resp = responses[callCount++ % responses.length];
      if (!resp) return;
      if (resp.error) throw resp.error;
      yield* resp.events ?? [];
    },
  };
}

const textEvent = (delta: string): StreamEvent => ({ type: "text_delta", delta });
const stopEvent: StreamEvent = { type: "stop", stopReason: "end_turn" };
const answer = (text: string): StreamEvent[] => [textEvent(text), stopEvent];

function serverError(status: number): Error {
  const err = new Error(`HTTP ${status}`);
  (err as unknown as Record<string, unknown>)["status"] = status;
  return err;
}

describe("FallbackModel (C3)", () => {
  it("throws when constructed with empty models list", () => {
    expect(() => new FallbackModel([])).toThrow("at least one model");
  });

  it("providerId matches the first model", () => {
    const m1 = mockModel([{ events: answer("ok") }]);
    const fallback = new FallbackModel([m1]);
    expect(fallback.providerId).toBe(m1.providerId);
  });

  it("yields from primary model when it succeeds", async () => {
    const primary = mockModel([{ events: answer("primary answer") }]);
    const secondary = mockModel([{ events: answer("secondary answer") }]);
    const fallback = new FallbackModel([primary, secondary]);

    const events: StreamEvent[] = [];
    for await (const ev of fallback.generate([{ role: "user", content: "q" }])) {
      events.push(ev);
    }
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    expect(text).toBe("primary answer");
  });

  it("falls back to secondary model on primary 5xx failure", async () => {
    const primary = mockModel([{ error: serverError(500) }]);
    const secondary = mockModel([{ events: answer("secondary answer") }]);
    const fallback = new FallbackModel([primary, secondary]);

    const events: StreamEvent[] = [];
    for await (const ev of fallback.generate([{ role: "user", content: "q" }])) {
      events.push(ev);
    }
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    expect(text).toBe("secondary answer");
    expect(fallback.lastActiveProviderId).toBe(secondary.providerId);
  });

  it("falls back to secondary on non-retryable 403 error", async () => {
    const primary = mockModel([{ error: serverError(403) }]);
    const secondary = mockModel([{ events: answer("from secondary") }]);
    const fallback = new FallbackModel([primary, secondary]);

    const events: StreamEvent[] = [];
    for await (const ev of fallback.generate([{ role: "user", content: "q" }])) {
      events.push(ev);
    }
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    expect(text).toBe("from secondary");
  });

  it("tries all models in order and uses the first successful one", async () => {
    const m1 = mockModel([{ error: serverError(500) }]);
    const m2 = mockModel([{ error: serverError(503) }]);
    const m3 = mockModel([{ events: answer("third wins") }]);
    const fallback = new FallbackModel([m1, m2, m3]);

    const events: StreamEvent[] = [];
    for await (const ev of fallback.generate([{ role: "user", content: "q" }])) {
      events.push(ev);
    }
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    expect(text).toBe("third wins");
    expect(fallback.lastActiveProviderId).toBe(m3.providerId);
  });

  it("throws the last error when all models fail", async () => {
    const m1 = mockModel([{ error: serverError(500) }]);
    const m2 = mockModel([{ error: serverError(503) }]);
    const fallback = new FallbackModel([m1, m2]);

    await expect(async () => {
      for await (const _ of fallback.generate([{ role: "user", content: "q" }])) { /* consume */ }
    }).rejects.toThrow();
  });

  it("single model — behaves like a direct Model passthrough", async () => {
    const m1 = mockModel([{ events: answer("direct") }]);
    const fallback = new FallbackModel([m1]);

    const events: StreamEvent[] = [];
    for await (const ev of fallback.generate([{ role: "user", content: "q" }])) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("")).toBe("direct");
  });

  it("merges capabilities from all models (most permissive)", () => {
    const m1 = mockModel([{ events: [] }]);
    m1.capabilities = { supportsGrammar: true, contextWindow: 128_000 };
    const m2 = mockModel([{ events: [] }]);
    m2.capabilities = { supportsReasoningEffort: true, contextWindow: 200_000 };
    const fallback = new FallbackModel([m1, m2]);
    expect(fallback.capabilities?.supportsGrammar).toBe(true);
    expect(fallback.capabilities?.supportsReasoningEffort).toBe(true);
    expect(fallback.capabilities?.contextWindow).toBe(200_000); // larger wins
  });

  it("forwards all GenerateOptions to the active model transparently", async () => {
    let capturedOpts: import("./types.js").GenerateOptions | undefined;
    const primary = mockModel([{ events: answer("ok") }]);
    const capturingModel: Model = {
      providerId: "capturing",
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        capturedOpts = opts;
        yield textEvent("ok");
        yield stopEvent;
      },
    };
    const fallback = new FallbackModel([capturingModel, primary]);
    const opts = { temperature: 0.5, maxTokens: 100 };
    for await (const _ of fallback.generate([{ role: "user", content: "q" }], opts)) { /* consume */ }
    expect(capturedOpts?.temperature).toBe(0.5);
    expect(capturedOpts?.maxTokens).toBe(100);
  });
});
