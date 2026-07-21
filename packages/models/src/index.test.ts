import { describe, expect, it } from "bun:test";
import {
  AnthropicModel,
  DeepSeekModel,
  DoubaoModel,
  MiniMaxModel,
  MoonshotModel,
  OpenAIModel,
  QwenModel,
  ZhipuModel,
} from "./index.js";

describe("@wasmagent/models barrel", () => {
  it("re-exports all model classes", () => {
    expect(AnthropicModel).toBeDefined();
    expect(OpenAIModel).toBeDefined();
    expect(DeepSeekModel).toBeDefined();
    expect(DoubaoModel).toBeDefined();
    expect(MiniMaxModel).toBeDefined();
    expect(MoonshotModel).toBeDefined();
    expect(QwenModel).toBeDefined();
    expect(ZhipuModel).toBeDefined();
  });
});
