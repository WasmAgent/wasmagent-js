/**
 * canonical.boundary.test.ts — pins the canonicalization boundary behaviour
 * that cross-language (Rust ↔ JS) signature verification depends on.
 *
 * Key ordering follows RFC 8785 §3.2.3: UTF-16 code-unit order, which is
 * JS's native Array.prototype.sort() order for strings.
 *
 * Every expectation here must stay in lockstep with the Rust tests in
 * wasmagent-proxy `crates/aep-core/src/dsse.rs` (module `tests`): the two
 * sides re-derive identical canonical bytes, and any change here that shifts
 * those bytes needs a matching change there (plus a predicate-type bump if
 * the shift is intentional).
 */
import { describe, expect, it } from "bun:test";
import { canonicalBytes } from "./canonical";

function canonicalText(obj: unknown): string {
  return new TextDecoder().decode(canonicalBytes(obj));
}

describe("canonical — hostile keys", () => {
  it("preserves a literal __proto__ key as an own property", () => {
    const record = JSON.parse('{"__proto__":{"x":1},"run_id":"r1"}');
    const out = canonicalText(record);
    expect(out).toBe('{"__proto__":{"x":1},"run_id":"r1"}');
  });

  it("__proto__ key sorts before 'a' (RFC 8785 UTF-16 code units)", () => {
    // "_" (0x5F) < "a" (0x61), so "__proto__" sorts before "a"
    const record = JSON.parse('{"a":1,"__proto__":2}');
    expect(canonicalText(record)).toBe('{"__proto__":2,"a":1}');
  });

  it("duplicate JSON keys: last value wins", () => {
    const record = JSON.parse('{"run_id":"first","run_id":"second"}');
    expect(canonicalText(record)).toBe('{"run_id":"second"}');
  });
});

describe("canonical — key ordering across planes (RFC 8785 UTF-16 code units)", () => {
  it("astral-plane character (U+10000) sorts before BMP non-ASCII (U+FF21)", () => {
    // RFC 8785 §3.2.3: UTF-16 code-unit order.
    // "\u{10000}" (U+10000) is represented as surrogate pair: lead \uD800 (55296).
    // "Ａ" (U+FF21) is single unit 0xFF21 (65313).
    // "a" (U+0061) = 97.
    // Sort order by first UTF-16 code unit: "a"(97) < "\u{10000}"(55296) < "Ａ"(65313)
    const record = JSON.parse('{"\u{10000}":1,"Ａ":2,"a":3}');
    expect(canonicalText(record)).toBe('{"a":3,"\u{10000}":1,"Ａ":2}');
  });

  it("integer-like string keys sort as strings, not numerically (RFC 8785)", () => {
    // "10" < "2" because '1'(0x31) < '2'(0x32)
    const record = JSON.parse('{"2":"two","10":"ten"}');
    expect(canonicalText(record)).toBe('{"10":"ten","2":"two"}');
  });

  it("prefix keys sort before their extensions", () => {
    const record = { run: 1, run_id: 2, run_id_extra: 3 };
    expect(canonicalText(record)).toBe('{"run":1,"run_id":2,"run_id_extra":3}');
  });

  it("ASCII keys match plain JSON.stringify sort order", () => {
    const record = { z: 1, a: 2, Z: 3, "0": 4, _: 5 };
    // UTF-16: '0'(30) < 'Z'(5A) < '_'(5F) < 'a'(61) < 'z'(7A)
    expect(canonicalText(record)).toBe('{"0":4,"Z":3,"_":5,"a":2,"z":1}');
  });
});

describe("canonical — arrays and nesting", () => {
  it("arrays preserve order (never sorted)", () => {
    const record = { list: ["z", "a", "m"], nested: { b: 1, a: 2 } };
    expect(canonicalText(record)).toBe('{"list":["z","a","m"],"nested":{"a":2,"b":1}}');
  });
});
