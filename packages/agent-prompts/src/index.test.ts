import { describe, expect, it } from "vitest";
import {
  CODE_QUALITY_GENERIC,
  CODE_QUALITY_TYPESCRIPT,
  composePrompt,
  DIAGRAMS_CODE_JS,
  DIAGRAMS_CODE_PYTHON,
  DIAGRAMS_GENERIC,
  ERROR_RECOVERY,
  FILE_OPS_ATOMIC,
  OUTPUT_CONTRACT_FINAL_ANSWER,
  OUTPUT_CONTRACT_STDOUT,
  REASONING_FIRST,
  SANDBOX_NODE,
  SANDBOX_PYODIDE,
  SANDBOX_QUICKJS,
  STRUCTURED_PLAN,
} from "./index.js";

describe("composePrompt", () => {
  it("returns empty string when given no input", () => {
    expect(composePrompt({})).toBe("");
  });

  it("includes only the persona when only persona is given", () => {
    expect(composePrompt({ persona: "I am Foo." })).toBe("I am Foo.");
  });

  it("joins persona + fragments + trailing with double newlines", () => {
    const result = composePrompt({
      persona: "I am Foo.",
      fragments: ["A", "B"],
      trailing: "End.",
    });
    expect(result).toBe("I am Foo.\n\nA\n\nB\n\nEnd.");
  });

  it("skips empty / whitespace-only sections", () => {
    const result = composePrompt({
      persona: "  ",
      fragments: ["A", "", "  ", "B"],
      trailing: "",
    });
    expect(result).toBe("A\n\nB");
  });

  it("trims each section", () => {
    expect(composePrompt({ persona: "  Hello  " })).toBe("Hello");
  });

  it("real-world: a JS code-agent prompt composed from fragments", () => {
    const prompt = composePrompt({
      persona: "You are an expert JavaScript coding assistant.",
      fragments: [
        REASONING_FIRST,
        SANDBOX_QUICKJS,
        OUTPUT_CONTRACT_FINAL_ANSWER,
        CODE_QUALITY_GENERIC,
        DIAGRAMS_CODE_JS,
        ERROR_RECOVERY,
      ],
    });
    expect(prompt).toContain("expert JavaScript coding assistant");
    expect(prompt).toContain("Reasoning-First");
    expect(prompt).toContain("WebAssembly");
    expect(prompt).toContain("__finalAnswer__");
    expect(prompt).toContain("card:d2");
    expect(prompt).toContain("Error Recovery");
  });
});

describe("fragment integrity", () => {
  it("REASONING_FIRST mentions approach and output shape", () => {
    expect(REASONING_FIRST).toContain("approach");
    expect(REASONING_FIRST).toContain("output");
  });

  it("STRUCTURED_PLAN has Phase 1 and Phase 2", () => {
    expect(STRUCTURED_PLAN).toContain("Phase 1");
    expect(STRUCTURED_PLAN).toContain("Phase 2");
  });

  it("OUTPUT_CONTRACT_FINAL_ANSWER mentions both __finalAnswer__ and __final_answer__", () => {
    expect(OUTPUT_CONTRACT_FINAL_ANSWER).toContain("__finalAnswer__");
    expect(OUTPUT_CONTRACT_FINAL_ANSWER).toContain("__final_answer__");
  });

  it("OUTPUT_CONTRACT_STDOUT mentions stdout and stderr distinction", () => {
    expect(OUTPUT_CONTRACT_STDOUT).toContain("stdout");
    expect(OUTPUT_CONTRACT_STDOUT).toContain("stderr");
  });

  it("CODE_QUALITY_TYPESCRIPT forbids any", () => {
    expect(CODE_QUALITY_TYPESCRIPT).toContain("No `any`");
  });

  it("ERROR_RECOVERY forbids repeating the same approach", () => {
    expect(ERROR_RECOVERY.toLowerCase()).toContain("change strategy");
  });

  it("FILE_OPS_ATOMIC forbids batching", () => {
    expect(FILE_OPS_ATOMIC.toLowerCase()).toContain("never batch");
  });

  it("SANDBOX_QUICKJS lists allowed globals", () => {
    expect(SANDBOX_QUICKJS).toContain("Math");
    expect(SANDBOX_QUICKJS).toContain("JSON");
    expect(SANDBOX_QUICKJS).toContain("Promise");
  });

  it("SANDBOX_PYODIDE warns about GUI libraries", () => {
    expect(SANDBOX_PYODIDE).toContain("tkinter");
    expect(SANDBOX_PYODIDE).toContain("Agg");
  });

  it("SANDBOX_NODE mentions full Node runtime", () => {
    expect(SANDBOX_NODE).toContain("Node.js");
  });
});

describe("diagram fragments", () => {
  it("DIAGRAMS_GENERIC mentions both card types with example syntax", () => {
    expect(DIAGRAMS_GENERIC).toContain("```card:d2");
    expect(DIAGRAMS_GENERIC).toContain("```card:markdown");
  });

  it("DIAGRAMS_CODE_JS targets HTML/SVG/Canvas alternatives", () => {
    expect(DIAGRAMS_CODE_JS).toContain("HTML/SVG/Canvas");
  });

  it("DIAGRAMS_CODE_PYTHON specifically references matplotlib", () => {
    expect(DIAGRAMS_CODE_PYTHON).toContain("matplotlib");
  });
});

describe("generic-foundation principle", () => {
  // The package must be product-agnostic. No bscode-specific tokens
  // should leak in (no "BSCode" persona, no "WebContainers" assumptions,
  // no "<boltThinking>" tag, etc.).
  const allFragments = [
    REASONING_FIRST,
    STRUCTURED_PLAN,
    OUTPUT_CONTRACT_FINAL_ANSWER,
    OUTPUT_CONTRACT_STDOUT,
    CODE_QUALITY_GENERIC,
    CODE_QUALITY_TYPESCRIPT,
    ERROR_RECOVERY,
    FILE_OPS_ATOMIC,
    SANDBOX_QUICKJS,
    SANDBOX_PYODIDE,
    SANDBOX_NODE,
    DIAGRAMS_GENERIC,
    DIAGRAMS_CODE_JS,
    DIAGRAMS_CODE_PYTHON,
  ].join("\n");

  it("no fragment names a specific product", () => {
    expect(allFragments).not.toMatch(/bscode/i);
    expect(allFragments).not.toContain("BSCode");
    expect(allFragments).not.toContain("Lovable");
    expect(allFragments).not.toContain("v0.dev");
    expect(allFragments).not.toContain("WebContainers");
    expect(allFragments).not.toContain("boltThinking");
    expect(allFragments).not.toContain("bolt.new");
  });

  it("no fragment hard-codes a specific framework or persona", () => {
    expect(allFragments).not.toContain("You are BSCode");
    expect(allFragments).not.toMatch(/<bolt[A-Z]/); // <boltThinking>, <boltAction>
  });
});
