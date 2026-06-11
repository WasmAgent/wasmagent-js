import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "agentkit-js",
  description:
    "TypeScript + WASM agent runtime — three-tier sandboxed code execution, prompt-cache cost control, edge-native, first-class Chinese model support.",
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ["meta", { name: "theme-color", content: "#646cff" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "agentkit-js" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "TypeScript + WASM agent runtime — three-tier sandboxed code execution, prompt-cache cost control, edge-native.",
      },
    ],
  ],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guides/getting-started" },
      { text: "Kernels", link: "/kernels/comparison" },
      { text: "Benchmarks", link: "/benchmarks" },
      { text: "Packages", link: "/packages" },
      {
        text: "Compare",
        items: [
          { text: "vs Vercel AI SDK / Mastra / LangGraph", link: "/compare" },
          { text: "Why three sandbox tiers?", link: "/kernels/comparison" },
        ],
      },
      {
        text: "GitHub",
        link: "https://github.com/telleroutlook/agentkit-js",
      },
    ],

    sidebar: {
      "/guides/": [
        {
          text: "Get started",
          items: [
            { text: "Getting started (5 min)", link: "/guides/getting-started" },
            { text: "中文：5 分钟上手", link: "/zh/getting-started" },
          ],
        },
        {
          text: "Core patterns",
          items: [
            { text: "Durable runtime", link: "/guides/durable-runtime" },
            { text: "Memory patterns", link: "/guides/memory-patterns" },
            { text: "Observational memory", link: "/guides/observational-memory" },
            { text: "Skills & lifecycle hooks", link: "/guides/skills-and-hooks" },
            { text: "DevTools (time travel)", link: "/guides/devtools" },
            { text: "Evals cookbook", link: "/guides/evals-cookbook" },
            { text: "MCP server", link: "/guides/mcp-server" },
            { text: "MCP deferred loading (–85 %)", link: "/guides/mcp-deferred-loading" },
            { text: "AGENTS.md project conventions", link: "/guides/agents-md" },
          ],
        },
        {
          text: "Integrate",
          items: [
            { text: "Use kernels with Vercel AI SDK", link: "/guides/integrate-vercel-ai-sdk" },
            { text: "Use kernels with Mastra", link: "/guides/integrate-mastra" },
          ],
        },
      ],

      "/kernels/": [
        {
          text: "Sandboxed code execution",
          items: [
            { text: "Decision tree & comparison", link: "/kernels/comparison" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/telleroutlook/agentkit-js" },
    ],

    footer: {
      message: "Released under the Apache-2.0 License.",
      copyright: "© agentkit-js contributors",
    },

    search: { provider: "local" },

    editLink: {
      pattern:
        "https://github.com/telleroutlook/agentkit-js/edit/main/docs/:path",
    },
  },

  // Don't crawl node_modules / .vitepress / dist
  srcExclude: ["**/node_modules/**", "**/dist/**", "**/.vitepress/cache/**"],

  // Some guides link to `../../examples/*` and `../../packages/*` paths that exist
  // in the repository but are outside the docs site. Allow those.
  ignoreDeadLinks: [
    /examples\//,
    /packages\//,
  ],
});
