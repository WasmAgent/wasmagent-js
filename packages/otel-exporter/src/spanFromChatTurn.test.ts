/**
 * Tests for spanFromChatTurn factory (#306).
 *
 * Verifies UUID→hex conversion, field defaults, status mapping,
 * and the `hasError` shorthand.
 */

import { describe, expect, it } from "bun:test";
import { spanFromChatTurn } from "./spanFromChatTurn.js";

describe("spanFromChatTurn (#306)", () => {
  it("converts a UUID traceId to 32-char hex", () => {
    const span = spanFromChatTurn({
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      name: "chat.turn",
      startMs: 1000,
      durationMs: 100,
    });
    expect(span.traceId).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(span.traceId)).toBe(true);
  });

  it("derives spanId from the lower 16 hex chars of traceId", () => {
    const span = spanFromChatTurn({
      traceId: "550e8400e29b41d4a716446655440000",
      name: "chat.turn",
      startMs: 1000,
      durationMs: 100,
    });
    expect(span.spanId).toBe("a716446655440000");
    expect(span.spanId).toHaveLength(16);
  });

  it("accepts an explicit spanId override", () => {
    const span = spanFromChatTurn({
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      spanId: "deadbeef12345678",
      name: "chat.turn",
      startMs: 1000,
      durationMs: 0,
    });
    expect(span.spanId).toBe("deadbeef12345678");
  });

  it("computes endTimeMs from startMs + durationMs", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 5000,
      durationMs: 250,
    });
    expect(span.endTimeMs).toBe(5250);
  });

  it("uses endMs when provided, ignoring durationMs", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 5000,
      durationMs: 999,
      endMs: 5300,
    });
    expect(span.endTimeMs).toBe(5300);
  });

  it("maps hasError:true to status 'error'", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 0,
      durationMs: 10,
      attributes: { hasError: true },
    });
    expect(span.status).toBe("error");
    // hasError must not appear as an OTLP attribute
    expect("hasError" in span.attributes).toBe(false);
  });

  it("maps hasError:false to status 'ok'", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 0,
      durationMs: 10,
      attributes: { hasError: false },
    });
    expect(span.status).toBe("ok");
  });

  it("explicit status takes precedence over hasError", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 0,
      durationMs: 10,
      attributes: { hasError: true },
      status: "unset",
    });
    expect(span.status).toBe("unset");
  });

  it("sets events to empty array and parentSpanId to undefined by default", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 0,
      durationMs: 1,
    });
    expect(span.events).toEqual([]);
    expect(span.parentSpanId).toBeUndefined();
  });

  it("converts a parentSpanId UUID to 16-char hex", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 0,
      durationMs: 1,
      parentSpanId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(span.parentSpanId).toBeDefined();
    expect(span.parentSpanId!).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(span.parentSpanId!)).toBe(true);
  });

  it("passes through arbitrary attributes (excluding hasError)", () => {
    const span = spanFromChatTurn({
      traceId: "aaaa",
      name: "chat.turn",
      startMs: 0,
      durationMs: 1,
      attributes: { userId: "u1", toolCallCount: 3 },
    });
    expect(span.attributes.userId).toBe("u1");
    expect(span.attributes.toolCallCount).toBe(3);
  });

  it("produces a valid span that OtlpHttpExporter can export without throwing", async () => {
    const { OtlpHttpExporter } = await import("./index.js");
    const fetchSpy = (() => {
      let called = false;
      const fn = async () => {
        called = true;
        return { ok: true, text: async () => "" } as Response;
      };
      fn.wasCalled = () => called;
      return fn;
    })();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const exporter = new OtlpHttpExporter({ endpoint: "http://localhost:4318" });
    const span = spanFromChatTurn({
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      name: "procureiq.chat.turn",
      startMs: Date.now() - 500,
      durationMs: 500,
      attributes: { userId: "u1", toolCallCount: 2, hasError: false },
    });
    await exporter.exportAsync([span]);
    expect(fetchSpy.wasCalled()).toBe(true);
  });
});
