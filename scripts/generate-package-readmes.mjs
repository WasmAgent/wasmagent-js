#!/usr/bin/env node
/**
 * Generate a per-package README.md for every package missing one.
 *
 * The template is intentionally short (~30-50 lines):
 *   - one-line title + tagline
 *   - install
 *   - minimal usage example (provider-specific where applicable)
 *   - links back to root README + relevant guides
 *
 * Re-running is safe: it skips packages that already have README.md.
 * Pass --force to overwrite (use only when you've intentionally removed one).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const packagesDir = join(repoRoot, "packages");
const force = process.argv.includes("--force");

// Per-package custom blocks (tagline + body). Keys are package basenames.
// Anything not listed gets a generic block built from package.json.description.
const PACKAGES = {
  core: {
    tagline: "Agent runtime — agents, kernels, models, tools, quality runners, evals, checkpoints.",
    install: `npm install @wasmagent/core @anthropic-ai/sdk`,
    body: `\`\`\`ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@wasmagent/core";

const agent = new CodeAgent({
  model: new AnthropicModel(AnthropicModels.SONNET_4_6, { apiKey: process.env.ANTHROPIC_API_KEY }),
});

const result = await agent.run({ task: "What is 12 * 13?" });
console.log(result.finalAnswer);
\`\`\`

See the [main README](https://github.com/WasmAgent/wasmagent-js#readme) for the full surface area:
agents, runners, kernels, models, tools, evals, checkpoints, and observability.`,
  },

  a2a: {
    tagline: "A2A (Agent2Agent) adapter — expose agents as A2A servers and call remote A2A agents.",
    install: `npm install @wasmagent/a2a @wasmagent/core`,
    body: `\`\`\`ts
import { A2AServer, A2ARemoteAgent } from "@wasmagent/a2a";
import { CodeAgent, AnthropicModel } from "@wasmagent/core";

// Expose your agent as A2A:
const server = new A2AServer(new CodeAgent({ model: new AnthropicModel(/*...*/) }));

// Or call a remote A2A agent as a tool:
const remote = new A2ARemoteAgent({ url: "https://other-team.example/a2a" });
\`\`\`

Aligns with the [Agent2Agent](https://github.com/google/A2A) protocol so wasmagent-js
agents interoperate with frameworks that support A2A (Google ADK, CrewAI 1.14+, etc.).`,
  },

  "ag-ui": {
    tagline: "AG-UI (inbound) HTTP transport for wasmagent-js agents — frame protocol + streaming.",
    install: `npm install @wasmagent/ag-ui @wasmagent/core`,
    body: `Expose any agent over the [AG-UI](https://github.com/ag-ui-protocol/ag-ui) frame protocol so
front-ends and agent IDEs can drive runs over a standard transport.`,
  },

  "agent-prompts": {
    tagline: "Reusable system prompt templates for wasmagent-js — code/tool/framework prompts with D2 + Markdown card conventions.",
    install: `npm install @wasmagent/agent-prompts`,
    body: `\`\`\`ts
import { composePrompt, codeAgentPrompt, cardConventions } from "@wasmagent/agent-prompts";

const system = composePrompt([codeAgentPrompt(), cardConventions()]);
\`\`\``,
  },

  cli: {
    tagline: "\`wasmagent\` command-line interface — run a single agent task from your shell.",
    install: `npm install -g @wasmagent/cli`,
    body: `\`\`\`bash
export ANTHROPIC_API_KEY=sk-ant-...
wasmagent run "What is 12 * 13?"
\`\`\``,
  },

  devtools: {
    tagline: "Time-travel debugger — \`EventLogReplay\` engine + opt-in \`<DevTools />\` React UI.",
    install: `npm install @wasmagent/devtools @wasmagent/core`,
    body: `Step-replay any \`EventLog\` and **fork from any step**. The React surface is opt-in via
the \`/react\` subpath (peer-depends on React, but never required for the core engine).

\`\`\`tsx
import { EventLogReplay } from "@wasmagent/devtools";
import { DevTools } from "@wasmagent/devtools/react";
\`\`\`

See [docs/guides/devtools.md](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/devtools.md).`,
  },

  "kernel-pyodide": {
    tagline: "CPython-in-WASM kernel (Pyodide) — run real Python code from agents on Node, Bun, and CF Workers.",
    install: `npm install @wasmagent/kernel-pyodide @wasmagent/core pyodide`,
    body: `\`\`\`ts
import { PyodideKernel } from "@wasmagent/kernel-pyodide";

const kernel = new PyodideKernel();
const result = await kernel.execute({
  code: \`import math; print(math.gcd(2024, 56))\`,
});
console.log(result.stdout); // 8
\`\`\`

> ⚠️ **Memory budget on edge runtimes** — Pyodide's WASM image and Python heap together are
> ~50–80 MB resident. Cloudflare Workers' free tier (~128 MB) leaves only thin headroom for
> user code; for memory-heavy workloads use [\`kernel-wasmtime\`](../kernel-wasmtime) or
> [\`kernel-remote\`](../kernel-remote) microVMs.

See the [kernel decision tree](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md).`,
  },

  "kernel-quickjs": {
    tagline: "QuickJS-in-WASM kernel — sandboxed JavaScript, edge-safe, no \`node:vm\` required.",
    install: `npm install @wasmagent/kernel-quickjs @wasmagent/core quickjs-emscripten @jitl/quickjs-wasmfile-release-sync`,
    body: `\`\`\`ts
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const kernel = new QuickJSKernel();
const result = await kernel.execute({
  code: \`return [1,2,3].reduce((a,b) => a+b, 0);\`,
});
console.log(result.value); // 6
\`\`\`

Drop-in replacement for \`VmKernel\` on **Cloudflare Workers** (which forbids \`node:vm\`),
Vercel Edge, Deno Deploy, and any environment where you want true language-level sandboxing
without spinning up a microVM.

See the [kernel decision tree](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md).`,
  },

  "kernel-wasmtime": {
    tagline: "True WASM sandbox via Javy + WASI — language-level isolation with zero \`node:vm\`.",
    install: `npm install @wasmagent/kernel-wasmtime @wasmagent/core`,
    body: `Compile JavaScript to WebAssembly via [Javy](https://github.com/bytecodealliance/javy) and run
it under a WASI host. Strongest sandboxing tier short of a microVM.

> Requires the \`javy\` CLI on your build environment.

See the [kernel decision tree](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md).`,
  },

  "kernel-remote": {
    tagline: "Remote sandbox kernel — execute agent code in E2B, Cloudflare Sandbox, or any HTTP-driven microVM.",
    install: `npm install @wasmagent/kernel-remote @wasmagent/core`,
    body: `\`\`\`ts
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote";

const kernel = new RemoteSandboxKernel({
  endpoint: process.env.SANDBOX_URL!,  // E2B / CF Sandbox / your own
  apiKey: process.env.SANDBOX_KEY!,
});
\`\`\`

Use this tier when agents need real shell access, npm install, or compilation chains —
i.e. things WASM kernels structurally cannot provide.

See the [kernel decision tree](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md).`,
  },

  "mcp-server": {
    tagline: "Expose any wasmagent-js agent as a Model Context Protocol (MCP) server.",
    install: `npm install @wasmagent/mcp-server @wasmagent/core @modelcontextprotocol/sdk`,
    body: `Wraps your agent's run loop in MCP so Claude Desktop, IDEs, and other MCP clients can call it
as a tool. Supports synchronous \`tools/call\` and the 2025-11-25 Tasks extension for long-running runs.

\`\`\`ts
import { McpAgentServer } from "@wasmagent/mcp-server";

const server = new McpAgentServer({ agent: myAgent });
await server.serve(); // listens on stdio (or pass { transport: "sse" } for HTTP)
\`\`\`

See [docs/guides/mcp-server.md](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/mcp-server.md).`,
  },

  "model-anthropic": {
    tagline: "Anthropic Claude adapter — auto prompt-cache breakpoints + 1-hour TTL.",
    install: `npm install @wasmagent/model-anthropic @wasmagent/core @anthropic-ai/sdk`,
    body: `\`\`\`ts
import { AnthropicModel, AnthropicModels } from "@wasmagent/model-anthropic";
const model = new AnthropicModel(AnthropicModels.SONNET_4_6, {
  apiKey: process.env.ANTHROPIC_API_KEY,
});
\`\`\``,
  },

  "model-openai": {
    tagline: "OpenAI / Azure OpenAI adapter for wasmagent-js.",
    install: `npm install @wasmagent/model-openai @wasmagent/core openai`,
    body: `\`\`\`ts
import { OpenAIModel, OpenAIModels } from "@wasmagent/model-openai";
const model = new OpenAIModel(OpenAIModels.GPT_4_1, {
  apiKey: process.env.OPENAI_API_KEY,
});
\`\`\``,
  },

  "model-doubao": {
    tagline: "Doubao / Volcengine Ark adapter — thinking tiers + \`auto-prefix\` / \`ark-context\` cache strategies.",
    install: `npm install @wasmagent/model-doubao @wasmagent/core`,
    body: `\`\`\`ts
import { DoubaoModel, DoubaoModels } from "@wasmagent/model-doubao";

const model = new DoubaoModel(DoubaoModels.DOUBAO_SEED_1_6, {
  apiKey: process.env.DOUBAO_API_KEY,
  thinking: { mode: "enabled", effort: "high" },
});
\`\`\`

> ⚠️ **Compliance** — Volcengine Ark may store request/response data per its [terms of service](https://www.volcengine.com/docs/82379). Review your data residency requirements before using in production.`,
  },

  "model-deepseek": {
    tagline: "DeepSeek V4 adapter — \`thinking: { type, effort }\` + auto-prefix prompt cache.",
    install: `npm install @wasmagent/model-deepseek @wasmagent/core`,
    body: `\`\`\`ts
import { DeepSeekModel, DeepSeekModels } from "@wasmagent/model-deepseek";

const model = new DeepSeekModel(DeepSeekModels.V4, {
  apiKey: process.env.DEEPSEEK_API_KEY,
  thinking: { type: "enabled", effort: "high" },
});
\`\`\`

> ⚠️ **Compliance** — Review the [DeepSeek terms of service](https://platform.deepseek.com/api-docs/) for data handling and regional access requirements.`,
  },

  "model-moonshot": {
    tagline: "Moonshot / Kimi K2.6 adapter — per-version reasoning field handling + auto-prefix cache.",
    install: `npm install @wasmagent/model-moonshot @wasmagent/core`,
    body: `\`\`\`ts
import { MoonshotModel, KimiModels } from "@wasmagent/model-moonshot";

const model = new MoonshotModel(KimiModels.K2_6, {
  apiKey: process.env.MOONSHOT_API_KEY,
  thinking: { type: "enabled" },
});
\`\`\`

> ⚠️ **Compliance** — Review the [Moonshot terms](https://platform.moonshot.cn/docs/agreement) before sending production data.`,
  },

  "model-qwen": {
    tagline: "Qwen3 (Alibaba DashScope) adapter — \`enable_thinking\` + \`thinking_budget\`, intl region routing.",
    install: `npm install @wasmagent/model-qwen @wasmagent/core`,
    body: `\`\`\`ts
import { QwenModel, QwenModels } from "@wasmagent/model-qwen";

const model = new QwenModel(QwenModels.QWEN3_MAX, {
  apiKey: process.env.DASHSCOPE_API_KEY,
  region: "intl", // or "cn"
  enable_thinking: true,
  thinking_budget: 10000,
});
\`\`\`

> ⚠️ **Compliance** — Review [Alibaba Cloud DashScope terms](https://help.aliyun.com/zh/model-studio/) for cross-border data transfer rules.`,
  },

  "model-zhipu": {
    tagline: "Zhipu GLM-5 adapter — \`thinking: { type }\` via \`extra_body\`, auto-prefix cache.",
    install: `npm install @wasmagent/model-zhipu @wasmagent/core`,
    body: `\`\`\`ts
import { ZhipuModel, GLMModels } from "@wasmagent/model-zhipu";

const model = new ZhipuModel(GLMModels.GLM_5, {
  apiKey: process.env.ZHIPU_API_KEY,
});
\`\`\`

> ⚠️ **Compliance** — Review the [Zhipu BigModel terms](https://open.bigmodel.cn/) before using in production.`,
  },

  "model-minimax": {
    tagline: "MiniMax M2/M3 adapter — \`reasoning_split\` + \`<think>\` tag parsing.",
    install: `npm install @wasmagent/model-minimax @wasmagent/core`,
    body: `\`\`\`ts
import { MiniMaxModel, MiniMaxModels } from "@wasmagent/model-minimax";

const model = new MiniMaxModel(MiniMaxModels.M3, {
  apiKey: process.env.MINIMAX_API_KEY,
});
\`\`\`

> ⚠️ **Compliance** — Review the [MiniMax terms](https://www.minimaxi.com/document/) before using in production.`,
  },

  "otel-exporter": {
    tagline: "OpenTelemetry exporter — wire wasmagent-js \`EventLog\` into Jaeger / Tempo / any OTLP collector.",
    install: `npm install @wasmagent/otel-exporter @wasmagent/core`,
    body: `Bridges agent events (model calls, tool calls, kernel executions) to OTLP traces with
correct parent/child span relationships. See \`examples/otel-jaeger\`.`,
  },

  react: {
    tagline: "React hook — \`useAgentRun()\` for streaming SSE agent events in Next.js / React apps.",
    install: `npm install @wasmagent/react @wasmagent/core`,
    body: `\`\`\`tsx
import { useAgentRun } from "@wasmagent/react";

const { events, finalAnswer, isRunning } = useAgentRun({ url: "/api/run" });
\`\`\``,
  },

  "tools-browser": {
    tagline: "Browser automation tools — Playwright session + CDP-bridge session, 5 tools (navigate / click / fill / screenshot / extract).",
    install: `npm install @wasmagent/tools-browser @wasmagent/core`,
    body: `Two interchangeable sessions: \`PlaywrightSession\` for local headless work,
\`CdpSession\` for connecting to an existing browser via the Chrome DevTools Protocol
(works inside Cloudflare Browser Rendering, browserless.io, or your own instance).`,
  },

  "tools-rag": {
    tagline: "RAG tools — \`HttpEmbedder\` + \`ragTool\` + Pinecone / Qdrant / in-memory connectors.",
    install: `npm install @wasmagent/tools-rag @wasmagent/core`,
    body: `\`\`\`ts
import { ragTool, HttpEmbedder, InMemoryVectorStore } from "@wasmagent/tools-rag";
\`\`\``,
  },

  "tools-web": {
    tagline: "Web search tool adapters — Tavily, Brave, Perplexity (LRU-cached, \`readOnly: true\`, \`idempotent: true\`).",
    install: `npm install @wasmagent/tools-web @wasmagent/core`,
    body: `\`\`\`ts
import { tavilySearch, braveSearch, perplexitySearch } from "@wasmagent/tools-web";
\`\`\``,
  },

  "ui-cards": {
    tagline: "Card block parser — extracts \`\`\`card:* fenced blocks (Markdown / D2 / extensible) from AI replies.",
    install: `npm install @wasmagent/ui-cards`,
    body: `\`\`\`ts
import { parseCards } from "@wasmagent/ui-cards";
const cards = parseCards(modelText);
\`\`\``,
  },

  "ui-cards-react": {
    tagline: "React components — \`MarkdownCard\`, \`D2Card\`, \`CardRenderer\`, \`ChatMessage\`.",
    install: `npm install @wasmagent/ui-cards-react @wasmagent/ui-cards react react-dom`,
    body: `\`\`\`tsx
import { ChatMessage } from "@wasmagent/ui-cards-react";
\`\`\``,
  },
};

let written = 0;
for (const name of readdirSync(packagesDir).sort()) {
  const dir = join(packagesDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private) continue;

  const readmePath = join(dir, "README.md");
  if (existsSync(readmePath) && !force) continue;

  const meta = PACKAGES[name];
  if (!meta) {
    console.error(`! no template for ${name} — add one to scripts/generate-package-readmes.mjs`);
    continue;
  }

  const content = `# ${pkg.name}

${meta.tagline}

> Part of [wasmagent-js](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

\`\`\`bash
${meta.install}
\`\`\`

## Usage

${meta.body}

## License

[Apache-2.0](./LICENSE) — © wasmagent-js contributors
`;

  writeFileSync(readmePath, content, "utf8");
  written++;
  console.log(`  • ${name}`);
}
console.log(`✓ wrote ${written} README(s)`);
