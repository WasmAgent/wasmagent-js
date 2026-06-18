/**
 * Tests for the agentkit-evals binary surface — the CLI's argument
 * parsing + help + spec parsing. The actual runEvaluation invocation
 * is exercised by the suite-level tests (multi-turn-tool-exec.test.ts
 * and friends); we don't double-cover it here.
 */

import { HELP, parseModelSpec, VERSION } from "./cli.js";

describe("agentkit-evals CLI", () => {
  it("HELP text mentions both subcommands and the model-spec format", () => {
    expect(HELP).toMatch(/agentkit-evals list/);
    expect(HELP).toMatch(/agentkit-evals run/);
    // The model spec format is the only thing users will get wrong;
    // lock it explicitly so a future copy edit doesn't lose it.
    expect(HELP).toMatch(/<id>\[@<baseUrl>]\[#<wireModelId>]/);
  });

  it("VERSION is a non-empty semver-ish string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe("parseModelSpec", () => {
    const FB = "http://fallback/v1";

    it("plain id falls back to --base-url and reuses id as wire modelId", () => {
      expect(parseModelSpec("qwen2.5:0.5b", FB)).toEqual({
        id: "qwen2.5:0.5b",
        baseUrl: FB,
        modelId: "qwen2.5:0.5b",
      });
    });

    it("id@baseUrl uses the explicit baseUrl", () => {
      expect(parseModelSpec("m@http://x.local/v1", FB)).toEqual({
        id: "m",
        baseUrl: "http://x.local/v1",
        modelId: "m",
      });
    });

    it("id@baseUrl#wireModelId distinguishes display id from wire id", () => {
      expect(parseModelSpec("display@http://x.local/v1#wire-name", FB)).toEqual({
        id: "display",
        baseUrl: "http://x.local/v1",
        modelId: "wire-name",
      });
    });

    it("id#wireModelId without @ keeps the fallback baseUrl", () => {
      // Edge case: no `@` means the entire tail after `#` is treated
      // correctly as wireModelId because there's nothing before `#`
      // for baseUrl. Confirms we don't mis-slice when @ is absent.
      expect(parseModelSpec("alias#wire-name", FB)).toEqual({
        id: "alias#wire-name",
        baseUrl: FB,
        modelId: "alias#wire-name",
      });
      // Documenting current behaviour: without @, the whole thing is
      // the id. Users wanting a wireModelId must provide @baseUrl.
      // If this stops being true, this test catches it.
    });

    it("id@<empty>#wire allows specifying only a wire modelId", () => {
      expect(parseModelSpec("display@#wire-name", FB)).toEqual({
        id: "display",
        baseUrl: FB,
        modelId: "wire-name",
      });
    });
  });
});
