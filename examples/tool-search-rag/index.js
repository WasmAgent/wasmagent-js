/**
 * End-to-end example: AI agent that searches the web with Tavily,
 * indexes the results into an InMemoryVectorStore using OpenAI
 * embeddings, then answers questions from the index.
 *
 * Required environment variables:
 *   ANTHROPIC_API_KEY   — Claude model
 *   TAVILY_API_KEY      — web search
 *   OPENAI_API_KEY      — embeddings
 *
 * Run:
 *   bun run start
 */
import { ToolCallingAgent } from "@agentkit-js/core";
import { AnthropicModel } from "@agentkit-js/model-anthropic";
import { tavilySearchTool } from "@agentkit-js/tools-web";
import {
  HttpEmbedder,
  InMemoryVectorStore,
  ragTool,
} from "@agentkit-js/tools-rag";

async function main() {
  const requireEnv = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
  };

  const model = new AnthropicModel(
    "claude-sonnet-4-6",
    requireEnv("ANTHROPIC_API_KEY")
  );

  // 1. Embedder + vector store (in-memory for the demo).
  const embedder = new HttpEmbedder({
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: "text-embedding-3-small",
  });
  const store = new InMemoryVectorStore(embedder);

  // 2. Pre-seed the store with some sample knowledge so the agent can
  //    immediately demonstrate retrieval. In a real app, content would
  //    be ingested from a search step or a file pipeline.
  const seed = [
    {
      id: "react-19",
      text: "React 19 introduced the use() hook for unwrapping promises in render. It also stabilized Actions and the React Compiler.",
    },
    {
      id: "vue-3.5",
      text: "Vue 3.5 added reactive props destructure and improved reactivity efficiency.",
    },
    {
      id: "agentkit",
      text: "agentkit-js is a TypeScript agent runtime built on WASM. It supports CodeAgent (sandboxed code execution) and ToolCallingAgent (function calling).",
    },
  ];
  for (const { id, text } of seed) await store.add(id, text);

  // 3. Build the toolset: web search + retrieval.
  const tools = [
    tavilySearchTool({ apiKey: requireEnv("TAVILY_API_KEY") }),
    ragTool({ store, topK: 3 }),
  ];

  const agent = new ToolCallingAgent({ tools, model, maxSteps: 6 });

  const task =
    "Use the retrieve tool to find what's new in React 19, then summarize it in 2 sentences.";

  for await (const ev of agent.run(task)) {
    if (ev.event === "tool_call" && ev.channel === "tool") {
      console.log(`→ tool_call: ${ev.data.toolName}(${JSON.stringify(ev.data.args)})`);
    } else if (ev.event === "tool_result" && ev.channel === "tool") {
      console.log(`← tool_result: ${ev.data.toolName} →`, JSON.stringify(ev.data.output).slice(0, 120));
    } else if (ev.event === "final_answer" && ev.channel === "text") {
      console.log("\n=== Final answer ===\n" + ev.data.answer);
    } else if (ev.event === "error") {
      console.error("ERROR:", ev.data.error);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
