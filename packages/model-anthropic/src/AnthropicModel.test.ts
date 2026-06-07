import { describe, it, expect } from "vitest";

/**
 * Smoke tests for the @agentkit-js/model-anthropic re-export package.
 *
 * These tests verify the re-export chain and static properties only.
 * Full behavioral tests live in @agentkit-js/core's AnthropicModel.test.ts,
 * which has direct access to the source files and proper SDK mock setup.
 */
describe("@agentkit-js/model-anthropic re-export", () => {
  it("exports AnthropicModel class", async () => {
    const { AnthropicModel } = await import("./index.js");
    expect(typeof AnthropicModel).toBe("function");
  });

  it("exports AnthropicModels enum with OPUS_LATEST, SONNET_LATEST, HAIKU_LATEST", async () => {
    const { AnthropicModels } = await import("./index.js");
    expect(typeof AnthropicModels.OPUS_LATEST).toBe("string");
    expect(typeof AnthropicModels.SONNET_LATEST).toBe("string");
    expect(typeof AnthropicModels.HAIKU_LATEST).toBe("string");
    expect(AnthropicModels.OPUS_LATEST).toBe("claude-opus-4-8");
  });

  it("exports CACHE_MIN_TOKENS map", async () => {
    const { CACHE_MIN_TOKENS } = await import("./index.js");
    expect(typeof CACHE_MIN_TOKENS).toBe("object");
  });

  it("AnthropicModel has expected capabilities", async () => {
    const { AnthropicModel } = await import("./index.js");
    const model = new AnthropicModel("claude-sonnet-4-6", "fake-key");
    expect(model.capabilities.metered).toBe(true);
    expect(model.capabilities.supportsGrammar).toBe(true);
    expect(model.capabilities.supportsBudgetForcing).toBe(true);
    expect(model.capabilities.cacheStrategy).toBe("anthropic-explicit");
  });

  it("AnthropicModel providerId is anthropic/<modelId>", async () => {
    const { AnthropicModel } = await import("./index.js");
    const model = new AnthropicModel("claude-opus-4-8", "key");
    expect(model.providerId).toBe("anthropic/claude-opus-4-8");
  });

  it("AnthropicModel exposes apiKey from options", async () => {
    const { AnthropicModel } = await import("./index.js");
    const model = new AnthropicModel("claude-sonnet-4-6", "my-key");
    expect(model.apiKey).toBe("my-key");
  });

  it("AnthropicModel accepts options object form", async () => {
    const { AnthropicModel } = await import("./index.js");
    const model = new AnthropicModel("claude-sonnet-4-6", { apiKey: "obj-key" });
    expect(model.apiKey).toBe("obj-key");
  });

  it("claude-opus-4-8 has supportsReasoningEffort=true (A1)", async () => {
    const { AnthropicModel } = await import("./index.js");
    const model = new AnthropicModel("claude-opus-4-8", "key");
    expect(model.capabilities.supportsReasoningEffort).toBe(true);
  });

  it("claude-sonnet-4-6 has supportsReasoningEffort=false", async () => {
    const { AnthropicModel } = await import("./index.js");
    const model = new AnthropicModel("claude-sonnet-4-6", "key");
    expect(model.capabilities.supportsReasoningEffort).toBe(false);
  });
});
