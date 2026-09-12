/**
 * canonical.boundary.test.ts — pins the canonicalization boundary behaviour
 * that cross-language (Rust ↔ JS) signature verification depends on.
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
  it("preserves a literal __proto__ key as an own property (serde BTreeMap keeps it too)", () => {
    // Parsed via JSON.parse so `__proto__` is an own data property, exactly
    // like a record arriving over the wire.
    const record = JSON.parse('{"__proto__":{"x":1},"run_id":"r1"}');
    const out = canonicalText(record);
    expect(out).toBe('{"__proto__":{"x":1},"run_id":"r1"}');
  });

  it("__proto__ key sorts by its own bytes, not via the prototype setter", () => {
    // "_" (0x5F) sorts after "a" (0x61)? No — before it. Pin the exact order.
    const record = JSON.parse('{"a":1,"__proto__":2}');
    expect(canonicalText(record)).toBe('{"__proto__":2,"a":1}');
  });

  it("duplicate JSON keys: last value wins, matching serde_json map insertion", () => {
    const record = JSON.parse('{"run_id":"first","run_id":"second"}');
    expect(canonicalText(record)).toBe('{"run_id":"second"}');
  });
});

describe("canonical — key ordering across planes", () => {
  it("orders keys by UTF-8 bytes, matching Rust BTreeMap, not UTF-16 code units", () => {
    // U+10000 encodes as F0 90 80 80; U+FF21 as EF BC A1. UTF-8 byte order
    // puts "Ａ" (EF…) before "𐀀" (F0…); UTF-16 code-unit order would put
    // "𐀀" (lead surrogate D800) first. Pin the byte order.
    const record = JSON.parse('{"\u{10000}":1,"\uFF21":2,"a":3}');
    expect(canonicalText(record)).toBe('{"a":3,"Ａ":2,"𐀀":1}');
  });

  it("prefix keys sort before their extensions (memcmp semantics)", () => {
    const record = { run: 1, run_id: 2, run_id_extra: 3 };
    expect(canonicalText(record)).toBe('{"run":1,"run_id":2,"run_id_extra":3}');
  });

  it("ASCII keys are byte-identical to plain JSON.stringify sort order", () => {
    const record = { z: 1, a: 2, Z: 3, "0": 4, _: 5 };
    // Byte order: '0'(30) < 'Z'(5A) < '_'(5F) < 'a'(61) < 'z'(7A)
    expect(canonicalText(record)).toBe('{"0":4,"Z":3,"_":5,"a":2,"z":1}');
  });
});

describe("canonical — arrays and nesting", () => {
  it("arrays preserve order (never sorted)", () => {
    const record = { list: ["z", "a", "m"], nested: { b: 1, a: 2 } };
    expect(canonicalText(record)).toBe('{"list":["z","a","m"],"nested":{"a":2,"b":1}}');
  });
});
