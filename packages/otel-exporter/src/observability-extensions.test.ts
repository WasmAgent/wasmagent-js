import { describe, expect, it } from "vitest";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  type Baggage,
  extractBaggage,
  FineGrainedMetrics,
  injectBaggage,
  ProbabilisticSampler,
  parseBaggageHeader,
  RateLimitingSampler,
  serializeBaggage,
  TraceRedactor,
} from "./index.js";

describe("Sampler implementations", () => {
  it("AlwaysOnSampler always returns true", () => {
    const s = new AlwaysOnSampler();
    expect(s.shouldSample("any")).toBe(true);
    expect(s.shouldSample("other")).toBe(true);
  });

  it("AlwaysOffSampler always returns false", () => {
    const s = new AlwaysOffSampler();
    expect(s.shouldSample("any")).toBe(false);
  });

  it("ProbabilisticSampler is deterministic per traceId", () => {
    const s = new ProbabilisticSampler(0.5);
    expect(s.shouldSample("trace-1")).toBe(s.shouldSample("trace-1"));
    expect(s.shouldSample("trace-2")).toBe(s.shouldSample("trace-2"));
  });

  it("ProbabilisticSampler at rate=1 always samples", () => {
    const s = new ProbabilisticSampler(1);
    for (let i = 0; i < 100; i++) expect(s.shouldSample(`t${i}`)).toBe(true);
  });

  it("ProbabilisticSampler at rate=0 never samples", () => {
    const s = new ProbabilisticSampler(0);
    for (let i = 0; i < 100; i++) expect(s.shouldSample(`t${i}`)).toBe(false);
  });

  it("ProbabilisticSampler rejects out-of-range rates", () => {
    expect(() => new ProbabilisticSampler(-0.1)).toThrow();
    expect(() => new ProbabilisticSampler(1.1)).toThrow();
  });

  it("RateLimitingSampler caps per second", () => {
    const s = new RateLimitingSampler(3);
    expect(s.shouldSample("t")).toBe(true);
    expect(s.shouldSample("t")).toBe(true);
    expect(s.shouldSample("t")).toBe(true);
    expect(s.shouldSample("t")).toBe(false);
  });
});

describe("TraceRedactor", () => {
  it("redacts emails", () => {
    const r = new TraceRedactor();
    expect(r.redactString("Contact me at alice@example.com")).toBe("Contact me at <email>");
  });

  it("redacts AWS keys", () => {
    const r = new TraceRedactor();
    expect(r.redactString("key=AKIAIOSFODNN7EXAMPLE")).toBe("key=<aws-key>");
  });

  it("redacts OpenAI-style sk- keys", () => {
    const r = new TraceRedactor();
    const out = r.redactString("auth: sk-proj-aaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toContain("<openai-key>");
  });

  it("walks objects recursively", () => {
    const r = new TraceRedactor();
    const out = r.redactValue({ user: "x@y.com", nested: { phone: "415 555 0123" } });
    expect(out).toEqual({ user: "<email>", nested: { phone: "<phone>" } });
  });

  it("can be disabled", () => {
    const r = new TraceRedactor({ enabled: false });
    expect(r.redactString("x@y.com")).toBe("x@y.com");
  });

  it("disablePatterns turns off specific built-ins", () => {
    const r = new TraceRedactor({ disablePatterns: ["email"] });
    expect(r.redactString("x@y.com")).toBe("x@y.com");
  });

  it("extraPatterns adds custom redactions", () => {
    const r = new TraceRedactor({
      extraPatterns: [{ name: "session", re: /sess_[a-f0-9]+/g, replacement: "<session>" }],
    });
    expect(r.redactString("sess_abc123def")).toBe("<session>");
  });
});

describe("BaggagePropagator", () => {
  it("parses simple baggage header", () => {
    expect(parseBaggageHeader("user-id=alice,session-id=42")).toEqual({
      "user-id": "alice",
      "session-id": "42",
    });
  });

  it("decodes URI-encoded keys + values", () => {
    expect(parseBaggageHeader("k%20with%20space=v%2Fwith%2Fslash")).toEqual({
      "k with space": "v/with/slash",
    });
  });

  it("strips metadata after semicolon", () => {
    expect(parseBaggageHeader("user=alice;ttl=60,role=admin")).toEqual({
      user: "alice",
      role: "admin",
    });
  });

  it("returns empty object for null/empty", () => {
    expect(parseBaggageHeader(null)).toEqual({});
    expect(parseBaggageHeader("")).toEqual({});
  });

  it("serializes baggage to header form", () => {
    const baggage: Baggage = { "user-id": "alice", "session-id": "42" };
    expect(serializeBaggage(baggage)).toBe("user-id=alice,session-id=42");
  });

  it("URI-encodes special chars on serialize", () => {
    expect(serializeBaggage({ key: "v with space" })).toBe("key=v%20with%20space");
  });

  it("extractBaggage reads from a Request-like object", () => {
    const req = { headers: { get: () => "tenant=acme" } };
    expect(extractBaggage(req)).toEqual({ tenant: "acme" });
  });

  it("injectBaggage sets the baggage header", () => {
    const headers = new Headers();
    injectBaggage(headers, { user: "alice" });
    expect(headers.get("baggage")).toBe("user=alice");
  });
});

describe("FineGrainedMetrics", () => {
  it("aggregates token + cost across recorded steps", () => {
    const m = new FineGrainedMetrics();
    m.recordStep({
      stepIndex: 0,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });
    m.recordStep({
      stepIndex: 1,
      durationMs: 150,
      inputTokens: 20,
      outputTokens: 8,
      costUsd: 0.002,
    });
    const snap = m.snapshot();
    expect(snap.totalInputTokens).toBe(30);
    expect(snap.totalOutputTokens).toBe(13);
    expect(snap.totalCostUsd).toBeCloseTo(0.003, 6);
    expect(snap.steps).toHaveLength(2);
  });

  it("tallies tool errors per name", () => {
    const m = new FineGrainedMetrics();
    m.recordToolError("search");
    m.recordToolError("search");
    m.recordToolError("calc");
    const snap = m.snapshot();
    expect(snap.toolErrors).toEqual(
      expect.arrayContaining([
        { toolName: "search", count: 2 },
        { toolName: "calc", count: 1 },
      ])
    );
  });

  it("reset clears state", () => {
    const m = new FineGrainedMetrics();
    m.recordStep({ stepIndex: 0, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    m.reset();
    expect(m.snapshot().steps).toEqual([]);
  });
});
