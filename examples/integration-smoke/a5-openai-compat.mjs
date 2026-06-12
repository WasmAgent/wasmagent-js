/**
 * A5 (S, 2026-06) integration smoke — construct GenericOpenAICompatModel
 * for the 5 typical recipes (Ollama, OpenRouter, AI Gateway, DeepSeek,
 * Groq). No network calls — we only assert that capabilities + providerId
 * + extras land where the recipe doc claims they do.
 */
import { GenericOpenAICompatModel } from "@agentkit-js/core";

function check(label, cond, detail) {
  if (!cond) {
    console.error(`[A5] ✗ ${label}`, detail ?? "");
    process.exit(1);
  }
  console.log(`[A5] ✓ ${label}`);
}

// 1. Ollama / LM Studio — local endpoint, not metered
const ollama = new GenericOpenAICompatModel("qwen2.5:14b", "http://localhost:11434/v1", {
  apiKey: "ollama",
  extraCapabilities: { localEndpoint: true, metered: false },
});
check("Ollama: providerId", ollama.providerId === "compat/qwen2.5:14b");
check("Ollama: localEndpoint", ollama.capabilities.localEndpoint === true);
check("Ollama: metered", ollama.capabilities.metered === false);

// 2. OpenRouter — default capabilities, custom headers
const openrouter = new GenericOpenAICompatModel(
  "anthropic/claude-3.5-sonnet",
  "https://openrouter.ai/api/v1",
  {
    apiKey: "or-test",
    defaultHeaders: { "HTTP-Referer": "https://example", "X-Title": "smoke" },
  }
);
check("OpenRouter: providerId", openrouter.providerId === "compat/anthropic/claude-3.5-sonnet");
check("OpenRouter: metered (default true)", openrouter.capabilities.metered === true);

// 3. Vercel AI Gateway
const vercel = new GenericOpenAICompatModel("openai/gpt-4o-mini", "https://gateway.ai.vercel.app/v1", {
  apiKey: "vc-test",
});
check("Vercel: providerId", vercel.providerId === "compat/openai/gpt-4o-mini");

// 4. DeepSeek with reasoning_content round-trip + thinking effort
const deepseek = new GenericOpenAICompatModel("deepseek-r1", "https://api.deepseek.com/v1", {
  apiKey: "ds-test",
  reasoningContentField: "reasoning_content",
  reasoningRoundTrip: "tool-turns-only",
  supportsReasoningEffort: true,
});
check("DeepSeek: providerId", deepseek.providerId === "compat/deepseek-r1");
check("DeepSeek: supportsReasoningEffort", deepseek.capabilities.supportsReasoningEffort === true);
check("DeepSeek: reasoningContentField surfaced",
  deepseek.capabilities.reasoningContentField === "reasoning_content");

// 5. Groq
const groq = new GenericOpenAICompatModel(
  "llama-3.3-70b-versatile",
  "https://api.groq.com/openai/v1",
  { apiKey: "gq-test" }
);
check("Groq: providerId", groq.providerId === "compat/llama-3.3-70b-versatile");

// 6. extraRequestParams surface (Qwen3 enable_thinking)
const qwen = new GenericOpenAICompatModel(
  "qwen3-235b-instruct",
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
  {
    apiKey: "qw-test",
    extraRequestParams: { enable_thinking: true },
    reasoningContentField: "reasoning_content",
  }
);
check("Qwen: providerId", qwen.providerId === "compat/qwen3-235b-instruct");
check("Qwen: reasoningContentField surfaced",
  qwen.capabilities.reasoningContentField === "reasoning_content");

console.log("\n[A5] all 6 recipes construct cleanly");
process.exit(0);
