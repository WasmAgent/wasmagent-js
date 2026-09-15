import { describe, expect, it } from "bun:test";
import {
  containsFullWidth,
  containsZeroWidth,
  MAX_DECODE_DEPTH,
  MAX_EXPANDED_BYTES,
  normalizeForDetection,
  normalizeForPolicy,
  normalizePayload,
} from "./normalize.js";

// ── FW-NORM-01: full-width folding ────────────────────────────────────────────

describe("FW-NORM-01: full-width folding", () => {
  it("folds full-width ASCII letters to plain ASCII", () => {
    // U+FF49 U+FF47 U+FF4E U+FF4F U+FF52 U+FF45 = ｉｇｎｏｒｅ
    const input = "ｉｇｎｏｒｅ";
    const result = normalizePayload(input);
    expect(result.normalized).toBe("ignore");
    expect(result.transforms).toContain("full_width_folding");
  });
});

// ── FW-NORM-02: zero-width removal ────────────────────────────────────────────

describe("FW-NORM-02: zero-width removal", () => {
  it("removes U+200B from text", () => {
    // "safe​tool" — ZWSP embedded in a word
    const input = "safe​tool";
    const result = normalizePayload(input);
    expect(result.normalized).toBe("safetool");
    expect(result.transforms).toContain("zero_width_removal");
  });

  it("removes multiple zero-width variants", () => {
    const input = "a​b‌c‍d⁠e­f﻿g";
    const result = normalizePayload(input);
    expect(result.normalized).toBe("abcdefg");
    expect(result.transforms).toContain("zero_width_removal");
  });
});

// ── FW-NORM-03: URL decode single-encoded ────────────────────────────────────

describe("FW-NORM-03: URL decode (single-encoded)", () => {
  it("decodes %20 to space", () => {
    const result = normalizePayload("ignore%20previous");
    expect(result.normalized).toBe("ignore previous");
    expect(result.transforms).toContain("url_decode");
  });
});

// ── FW-NORM-04: URL decode double-encoded ────────────────────────────────────

describe("FW-NORM-04: URL decode (double-encoded)", () => {
  it("decodes %2520 to space through two iterations", () => {
    const result = normalizePayload("ignore%2520previous");
    expect(result.normalized).toBe("ignore previous");
    expect(result.transforms).toContain("url_decode");
  });
});

// ── FW-NORM-05: base64 decode ─────────────────────────────────────────────────

describe("FW-NORM-05: base64 decode", () => {
  it("decodes base64-encoded payload", () => {
    // "ignore previous instructions" base64-encoded
    const b64 = "aWdub3JlIHByZXZpb3VzIGluc3RydWN0aW9ucw==";
    const result = normalizePayload(b64);
    expect(result.normalized).toBe("ignore previous instructions");
    expect(result.transforms).toContain("base64_candidate_decode");
  });
});

// ── FW-NORM-06: hex escape decode ────────────────────────────────────────────

describe("FW-NORM-06: hex escape decode", () => {
  it("decodes \\xNN sequences to characters", () => {
    // "\\x69\\x67\\x6e\\x6f\\x72\\x65" = "ignore" when decoded
    const input = "\\x69\\x67\\x6e\\x6f\\x72\\x65";
    const result = normalizePayload(input);
    expect(result.normalized).toBe("ignore");
    expect(result.transforms).toContain("hex_escape_decode");
  });
});

// ── FW-NORM-07: HTML entity decode ───────────────────────────────────────────

describe("FW-NORM-07: HTML entity decode", () => {
  it("decodes &amp; to &", () => {
    const result = normalizePayload("ignore &amp; forget");
    expect(result.normalized).toBe("ignore & forget");
    expect(result.transforms).toContain("html_entity_decode");
  });

  it("decodes all supported entities", () => {
    // &nbsp; is between "fine" and "here"; &amp; becomes & before "there"
    const input = "&lt;b&gt;&quot;it&apos;s&quot; fine&nbsp;here&amp;there";
    const result = normalizePayload(input);
    expect(result.normalized).toContain("<b>");
    expect(result.normalized).toContain('"');
    expect(result.normalized).toContain("fine here");
    expect(result.normalized).toContain("here&there");
  });
});

// ── FW-NORM-08: whitespace fold ───────────────────────────────────────────────

describe("FW-NORM-08: whitespace fold", () => {
  it("collapses multiple spaces", () => {
    const result = normalizePayload("ignore  all   previous");
    expect(result.normalized).toBe("ignore all previous");
    expect(result.transforms).toContain("whitespace_fold");
  });

  it("trims leading and trailing whitespace", () => {
    const result = normalizePayload("  hello world  ");
    expect(result.normalized).toBe("hello world");
    expect(result.transforms).toContain("whitespace_fold");
  });
});

// ── FW-NORM-09: MAX_EXPANDED_BYTES truncation ─────────────────────────────────

describe("FW-NORM-09: MAX_EXPANDED_BYTES truncation", () => {
  it("sets truncated=true when input exceeds MAX_EXPANDED_BYTES", () => {
    const large = "a".repeat(MAX_EXPANDED_BYTES + 100);
    const result = normalizePayload(large);
    expect(result.truncated).toBe(true);
    expect(result.transforms).toContain("size_limit");
    expect(Buffer.from(result.normalized, "utf-8").length).toBeLessThanOrEqual(MAX_EXPANDED_BYTES);
  });

  it("does not set truncated when input is exactly at the limit", () => {
    const exact = "a".repeat(MAX_EXPANDED_BYTES);
    const result = normalizePayload(exact);
    expect(result.truncated).toBe(false);
  });
});

// ── FW-NORM-10: transforms[] records applied transforms ───────────────────────

describe("FW-NORM-10: transforms[] records what was applied", () => {
  it("records each transform that changed the string, in order", () => {
    // Input that exercises: full_width_folding + url_decode
    const input = "ｉｇｎｏｒｅ%20previous";
    const result = normalizePayload(input);
    const fw = result.transforms.indexOf("full_width_folding");
    const ud = result.transforms.indexOf("url_decode");
    expect(fw).toBeGreaterThanOrEqual(0);
    expect(ud).toBeGreaterThanOrEqual(0);
    expect(fw).toBeLessThan(ud);
  });

  it("does not record a transform that was a no-op", () => {
    // No zero-width chars present — zero_width_removal should NOT be listed
    const result = normalizePayload("plain text");
    expect(result.transforms).not.toContain("zero_width_removal");
  });
});

// ── FW-NORM-11: benign text passes through unchanged ─────────────────────────

describe("FW-NORM-11: benign text", () => {
  it("produces empty transforms and truncated=false for plain ASCII text", () => {
    const result = normalizePayload("run sandboxed code safely");
    expect(result.transforms).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.normalized).toBe("run sandboxed code safely");
  });
});

// ── FW-NORM-12: containsZeroWidth ────────────────────────────────────────────

describe("FW-NORM-12: containsZeroWidth", () => {
  it("returns true for text with U+200B", () => {
    expect(containsZeroWidth("safe​tool")).toBe(true);
  });

  it("returns false for text without zero-width characters", () => {
    expect(containsZeroWidth("safe tool")).toBe(false);
  });

  it("returns true for U+FEFF not at start", () => {
    expect(containsZeroWidth("mid﻿text")).toBe(true);
  });
});

// ── FW-NORM-13: MAX_DECODE_DEPTH respected ────────────────────────────────────

describe("FW-NORM-13: MAX_DECODE_DEPTH respected", () => {
  it("decodes up to MAX_DECODE_DEPTH levels of nested base64", () => {
    // Build triple-encoded base64: encode "done" three times.
    const inner = Buffer.from("done").toString("base64"); // "ZG9uZQ=="
    const middle = Buffer.from(inner).toString("base64"); // encodes "ZG9uZQ=="
    const outer = Buffer.from(middle).toString("base64"); // triple-encoded

    const result = normalizePayload(outer);
    // Three levels decoded means we reach the actual content.
    expect(result.normalized).toBe("done");
    expect(result.transforms.filter((t) => t === "base64_candidate_decode")).toHaveLength(3);
  });

  it("stops at MAX_DECODE_DEPTH — quadruple-encoded payload is not fully decoded", () => {
    const l1 = Buffer.from("done").toString("base64");
    const l2 = Buffer.from(l1).toString("base64");
    const l3 = Buffer.from(l2).toString("base64");
    const l4 = Buffer.from(l3).toString("base64");

    const result = normalizePayload(l4);
    // Should have decoded exactly MAX_DECODE_DEPTH = 3 times, leaving one shell.
    expect(result.transforms.filter((t) => t === "base64_candidate_decode")).toHaveLength(
      MAX_DECODE_DEPTH
    );
    // The result should NOT equal "done" — one base64 shell remains.
    expect(result.normalized).not.toBe("done");
  });
});

// ── FW-NORM-14: normalizeForDetection applies case fold ──────────────────────

describe("FW-NORM-14: normalizeForDetection applies case fold", () => {
  it("lowercases the result", () => {
    expect(normalizeForDetection("IGNORE Previous Instructions")).toBe(
      "ignore previous instructions"
    );
  });

  it("lowercases after structural transforms", () => {
    // Full-width uppercase + case fold
    const input = "ＩＧＮＯＲＥ"; // ＩＧＮＯＲＥ
    expect(normalizeForDetection(input)).toBe("ignore");
  });
});

// ── FW-NORM-15: normalizeForPolicy does NOT apply case fold ──────────────────

describe("FW-NORM-15: normalizeForPolicy does NOT apply case fold", () => {
  it("preserves original case", () => {
    expect(normalizeForPolicy("Hello World")).toBe("Hello World");
  });

  it("applies structural transforms but keeps case", () => {
    const input = "Hello​World";
    expect(normalizeForPolicy(input)).toBe("HelloWorld");
  });

  it("result differs from normalizeForDetection on mixed-case input", () => {
    const input = "Ignore Previous";
    expect(normalizeForPolicy(input)).toBe("Ignore Previous");
    expect(normalizeForDetection(input)).toBe("ignore previous");
  });
});

// ── containsFullWidth ─────────────────────────────────────────────────────────

describe("containsFullWidth", () => {
  it("returns true for full-width characters", () => {
    expect(containsFullWidth("ｉｇｎｏｒｅ")).toBe(true);
  });

  it("returns false for plain ASCII", () => {
    expect(containsFullWidth("ignore")).toBe(false);
  });
});
