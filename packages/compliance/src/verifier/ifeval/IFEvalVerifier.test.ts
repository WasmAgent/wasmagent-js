/**
 * IFEvalVerifier — per-class unit tests.
 *
 * Strategy: for each of the 15 supported instruction classes, hand-pick
 * one positive example (response that should pass) and one negative
 * example (response that should fail). The verifier is pure, so this
 * gives us solid behaviour coverage without depending on the curated
 * samples.jsonl on disk.
 *
 * A separate integration test (ifeval-loader.test.ts) reads the real
 * samples.jsonl and confirms the loader + verifier handshake.
 */

import { describe, expect, test } from "bun:test";
import type { Criterion, WorkspaceReader } from "@wasmagent/core";
import { IFEvalVerifier } from "./IFEvalVerifier.js";

function ws(response: string): WorkspaceReader {
  return {
    async readFile(path) {
      if (path !== "r.txt") throw new Error(`no such file: ${path}`);
      return response;
    },
    async fileExists(path) {
      return path === "r.txt";
    },
    async fileSize(path) {
      if (path !== "r.txt") throw new Error(`no such file: ${path}`);
      return Buffer.byteLength(response, "utf8");
    },
  };
}

function c(verifyMethod: string, arg?: unknown): Criterion {
  return {
    id: "c1",
    description: verifyMethod,
    verify_method: verifyMethod,
    arg,
    path: "r.txt",
  };
}

const v = new IFEvalVerifier();

describe("IFEvalVerifier — punctuation:no_comma", () => {
  test("passes when no commas present", async () => {
    const verdict = await v.verify(c("ifeval:punctuation:no_comma"), ws("a sentence"));
    expect(verdict.ok).toBe(true);
  });
  test("fails when commas present", async () => {
    const verdict = await v.verify(c("ifeval:punctuation:no_comma"), ws("a, b, c"));
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — length_constraints:number_words", () => {
  test("at least passes when count meets bound", async () => {
    const text = "word ".repeat(20).trim();
    const verdict = await v.verify(
      c("ifeval:length_constraints:number_words", { relation: "at least", num_words: 10 }),
      ws(text)
    );
    expect(verdict.ok).toBe(true);
  });
  test("at least fails when count below bound", async () => {
    const verdict = await v.verify(
      c("ifeval:length_constraints:number_words", { relation: "at least", num_words: 100 }),
      ws("short.")
    );
    expect(verdict.ok).toBe(false);
  });
  test("less than passes when count below bound", async () => {
    const verdict = await v.verify(
      c("ifeval:length_constraints:number_words", { relation: "less than", num_words: 5 }),
      ws("one two")
    );
    expect(verdict.ok).toBe(true);
  });
  test("less than fails when count meets bound", async () => {
    const verdict = await v.verify(
      c("ifeval:length_constraints:number_words", { relation: "less than", num_words: 2 }),
      ws("one two three")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — length_constraints:number_sentences", () => {
  test("at least passes", async () => {
    const verdict = await v.verify(
      c("ifeval:length_constraints:number_sentences", { relation: "at least", num_sentences: 2 }),
      ws("First. Second. Third.")
    );
    expect(verdict.ok).toBe(true);
  });
  test("less than fails", async () => {
    const verdict = await v.verify(
      c("ifeval:length_constraints:number_sentences", { relation: "less than", num_sentences: 2 }),
      ws("One. Two.")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — keywords:forbidden_words", () => {
  test("passes when forbidden words absent", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:forbidden_words", { forbidden_words: ["rock", "stone"] }),
      ws("a soft pillow")
    );
    expect(verdict.ok).toBe(true);
  });
  test("fails when a forbidden word is present (case-insensitive)", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:forbidden_words", { forbidden_words: ["rock"] }),
      ws("The Rock band toured.")
    );
    expect(verdict.ok).toBe(false);
  });
  test("word boundary prevents substring false positive", async () => {
    // "rocky" should NOT match "rock"
    const verdict = await v.verify(
      c("ifeval:keywords:forbidden_words", { forbidden_words: ["rock"] }),
      ws("rocky road")
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("IFEvalVerifier — keywords:existence", () => {
  test("passes when all keywords appear", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:existence", { keywords: ["correlated", "experiencing"] }),
      ws("the patient is experiencing symptoms correlated with the disease")
    );
    expect(verdict.ok).toBe(true);
  });
  test("fails when a keyword is missing", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:existence", { keywords: ["unicorn"] }),
      ws("the meeting went well")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — keywords:frequency", () => {
  test("at least passes when keyword appears enough times", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:frequency", { relation: "at least", keyword: "story", frequency: 2 }),
      ws("a story about a story within a story")
    );
    expect(verdict.ok).toBe(true);
  });
  test("at least fails when too few", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:frequency", { relation: "at least", keyword: "story", frequency: 3 }),
      ws("a story")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — keywords:letter_frequency", () => {
  test("at least passes", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:letter_frequency", {
        let_relation: "at least",
        letter: "#",
        let_frequency: 3,
      }),
      ws("### heading")
    );
    expect(verdict.ok).toBe(true);
  });
  test("less than fails when count meets bound", async () => {
    const verdict = await v.verify(
      c("ifeval:keywords:letter_frequency", {
        let_relation: "less than",
        letter: "a",
        let_frequency: 2,
      }),
      ws("aaa")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — detectable_format:number_highlighted_sections", () => {
  test("passes when enough sections highlighted", async () => {
    const verdict = await v.verify(
      c("ifeval:detectable_format:number_highlighted_sections", { num_highlights: 3 }),
      ws("*one* and *two* and *three*")
    );
    expect(verdict.ok).toBe(true);
  });
  test("fails when too few", async () => {
    const verdict = await v.verify(
      c("ifeval:detectable_format:number_highlighted_sections", { num_highlights: 3 }),
      ws("*just one*")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — detectable_format:number_bullet_lists", () => {
  test("passes when exact count matches", async () => {
    const verdict = await v.verify(
      c("ifeval:detectable_format:number_bullet_lists", { num_bullets: 3 }),
      ws("- a\n- b\n- c")
    );
    expect(verdict.ok).toBe(true);
  });
  test("fails when count differs", async () => {
    const verdict = await v.verify(
      c("ifeval:detectable_format:number_bullet_lists", { num_bullets: 3 }),
      ws("- a\n- b")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — detectable_format:title", () => {
  test("passes when <<...>> present", async () => {
    const verdict = await v.verify(c("ifeval:detectable_format:title"), ws("<<my title>>\nbody"));
    expect(verdict.ok).toBe(true);
  });
  test("fails when title missing", async () => {
    const verdict = await v.verify(c("ifeval:detectable_format:title"), ws("body only"));
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — detectable_content:number_placeholders", () => {
  test("passes when enough [bracketed] placeholders", async () => {
    const verdict = await v.verify(
      c("ifeval:detectable_content:number_placeholders", { num_placeholders: 2 }),
      ws("write to [name] at [address]")
    );
    expect(verdict.ok).toBe(true);
  });
  test("fails when too few", async () => {
    const verdict = await v.verify(
      c("ifeval:detectable_content:number_placeholders", { num_placeholders: 3 }),
      ws("[only one]")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — combination:repeat_prompt", () => {
  test("passes when response starts with prompt verbatim", async () => {
    const prompt = "Write a haiku.";
    const verdict = await v.verify(
      c("ifeval:combination:repeat_prompt", { prompt_to_repeat: prompt }),
      ws(`${prompt}\n\nstars above\nsilent night`)
    );
    expect(verdict.ok).toBe(true);
  });
  test("fails when response doesn't start with prompt", async () => {
    const verdict = await v.verify(
      c("ifeval:combination:repeat_prompt", { prompt_to_repeat: "Hello." }),
      ws("Hi! Hello.")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — startend:quotation", () => {
  test("passes when whole response wrapped in quotes", async () => {
    const verdict = await v.verify(c("ifeval:startend:quotation"), ws('"hello world"'));
    expect(verdict.ok).toBe(true);
  });
  test("fails when not quoted", async () => {
    const verdict = await v.verify(c("ifeval:startend:quotation"), ws("hello world"));
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — change_case:english_lowercase", () => {
  test("passes when all ASCII letters lowercase", async () => {
    const verdict = await v.verify(c("ifeval:change_case:english_lowercase"), ws("hello world"));
    expect(verdict.ok).toBe(true);
  });
  test("fails when an uppercase ASCII letter present", async () => {
    const verdict = await v.verify(c("ifeval:change_case:english_lowercase"), ws("Hello world"));
    expect(verdict.ok).toBe(false);
  });
  test("passes for non-Latin scripts (no ASCII letters at all)", async () => {
    const verdict = await v.verify(c("ifeval:change_case:english_lowercase"), ws("你好世界"));
    expect(verdict.ok).toBe(true);
  });
});

describe("IFEvalVerifier — language:response_language", () => {
  test("passes when script majority matches", async () => {
    const verdict = await v.verify(
      c("ifeval:language:response_language", { language: "zh" }),
      ws("这是一段中文回复")
    );
    expect(verdict.ok).toBe(true);
  });
  test("fails when script majority is wrong", async () => {
    const verdict = await v.verify(
      c("ifeval:language:response_language", { language: "kn" }),
      ws("This is English.")
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("IFEvalVerifier — error handling", () => {
  test("missing path is a clean failure, not a throw", async () => {
    const verdict = await v.verify(
      { id: "c1", description: "", verify_method: "ifeval:punctuation:no_comma" },
      ws("anything")
    );
    expect(verdict.ok).toBe(false);
  });
  test("missing file is a clean failure", async () => {
    const verdict = await v.verify(
      c("ifeval:punctuation:no_comma"),
      // workspace with no files at all
      {
        readFile: async () => {
          throw new Error("no");
        },
        fileExists: async () => false,
        fileSize: async () => 0,
      }
    );
    expect(verdict.ok).toBe(false);
  });
});
