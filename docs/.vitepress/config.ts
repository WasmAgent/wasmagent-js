import { defineConfig } from "vitepress";

const enNav = [
  { text: "Guide", link: "/guides/getting-started" },
  { text: "Ecosystem", link: "/ecosystem" },
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
  { text: "GitHub", link: "https://github.com/WasmAgent/wasmagent-js" },
];

const enSidebar = {
  "/guides/": [
    {
      text: "Get started",
      items: [
        { text: "Getting started (5 min)", link: "/guides/getting-started" },
        { text: "中文：5 分钟上手", link: "/zh/guides/getting-started" },
      ],
    },
    {
      text: "Core patterns",
      items: [
        { text: "Durable runtime", link: "/guides/durable-runtime" },
        { text: "Memory (overview + decision tree)", link: "/guides/memory" },
        { text: "Memory patterns (reference)", link: "/guides/memory-patterns" },
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
    {
      text: "RLAIF data pipeline",
      items: [
        { text: "Ecosystem overview", link: "/ecosystem" },
        { text: "Data pipeline guide", link: "/data-pipeline" },
        { text: "RLAIF rollout", link: "/guides/rlaif-rollout" },
        { text: "Schema governance", link: "/schemas/GOVERNANCE" },
      ],
    },
  ],

  "/kernels/": [
    {
      text: "Sandboxed code execution",
      items: [{ text: "Decision tree & comparison", link: "/kernels/comparison" }],
    },
  ],
};

const zhNav = [
  { text: "指南", link: "/zh/guides/getting-started" },
  { text: "Kernel 对比", link: "/zh/kernels-comparison" },
  { text: "基准数字", link: "/zh/benchmarks" },
  { text: "包结构", link: "/zh/packages" },
  {
    text: "对比",
    items: [
      { text: "vs Vercel AI SDK / Mastra / LangGraph", link: "/zh/compare" },
      { text: "为什么是三层沙箱?", link: "/zh/kernels-comparison" },
    ],
  },
  { text: "GitHub", link: "https://github.com/WasmAgent/wasmagent-js" },
];

const zhSidebar = {
  "/zh/": [
    {
      text: "起步",
      items: [
        { text: "5 分钟上手", link: "/zh/guides/getting-started" },
        { text: "对比 / Compare", link: "/zh/compare" },
        { text: "基准数字", link: "/zh/benchmarks" },
        { text: "包结构", link: "/zh/packages" },
      ],
    },
    {
      text: "核心模式",
      items: [
        { text: "Durable runtime", link: "/zh/guides/durable-runtime" },
        { text: "Memory 模式", link: "/zh/guides/memory-patterns" },
        { text: "观察记忆", link: "/zh/guides/observational-memory" },
        { text: "Skills & 生命周期 hook", link: "/zh/guides/skills-and-hooks" },
        { text: "DevTools 时间旅行", link: "/zh/guides/devtools" },
        { text: "Evals 实战手册", link: "/zh/guides/evals-cookbook" },
        { text: "MCP server", link: "/zh/guides/mcp-server" },
        { text: "MCP 延迟加载（–85%）", link: "/zh/guides/mcp-deferred-loading" },
        { text: "AGENTS.md 项目约定", link: "/zh/guides/agents-md" },
      ],
    },
    {
      text: "集成",
      items: [
        { text: "Vercel AI SDK", link: "/zh/guides/integrate-vercel-ai-sdk" },
        { text: "Mastra", link: "/zh/guides/integrate-mastra" },
      ],
    },
    {
      text: "Kernel",
      items: [{ text: "决策树与对比", link: "/zh/kernels-comparison" }],
    },
  ],
};

export default defineConfig({
  base: "/wasmagent-js/",
  title: "wasmagent",
  description:
    "WASM Agent Kernel & Portable Code Executor — three-tier sandboxed execution, prompt-cache optimization, edge-native TypeScript agent runtime.",
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ["meta", { name: "theme-color", content: "#646cff" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "wasmagent" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "WASM Agent Kernel & Portable Code Executor — three-tier sandboxed execution, prompt-cache optimization, edge-native TypeScript agent runtime.",
      },
    ],
  ],

  // Multi-language sites — root EN, /zh/ Chinese.
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
      },
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh/",
      themeConfig: {
        nav: zhNav,
        sidebar: zhSidebar,
        outline: { label: "本页内容" },
        darkModeSwitchLabel: "外观",
        sidebarMenuLabel: "菜单",
        returnToTopLabel: "回到顶部",
        lastUpdatedText: "最后更新",
        docFooter: { prev: "上一篇", next: "下一篇" },
        editLink: {
          pattern: "https://github.com/WasmAgent/wasmagent-js/edit/main/docs/:path",
          text: "在 GitHub 上编辑此页",
        },
      },
    },
  },

  themeConfig: {
    socialLinks: [{ icon: "github", link: "https://github.com/WasmAgent/wasmagent-js" }],

    footer: {
      message: "Released under the Apache-2.0 License.",
      copyright: "© wasmagent contributors",
    },

    search: { provider: "local" },

    editLink: {
      pattern: "https://github.com/WasmAgent/wasmagent-js/edit/main/docs/:path",
    },
  },

  srcExclude: ["**/node_modules/**", "**/dist/**", "**/.vitepress/cache/**"],

  // Some guides link to `../../examples/*` and `../../packages/*` paths that exist
  // in the repository but are outside the docs site. Allow those, plus repo-root
  // governance files (LICENSE / CHANGELOG / ROADMAP / SECURITY / CONTRIBUTING /
  // GOVERNANCE / bun.lock) and links into the user's local memory directory
  // (`./../../../.claude/...`) — those are valid on GitHub but not on the docs
  // site. Also allow the cross-doc references to memory.md / reward-hacking.md
  // that aren't yet published on the docs site.
  ignoreDeadLinks: [
    /examples\//,
    /packages\//,
    /\.\.\/(\.\.\/)*(LICENSE|CHANGELOG|ROADMAP|SECURITY|CONTRIBUTING|GOVERNANCE|bun\.lock)$/,
    /\.claude\//,
    /openai-compat-recipes$/,
    /^\.\/memory$/,
    /^\.\/reward-hacking$/,
    /\/reports\/index$/,
    /\/reports\/arm-f-vs-bare-2026-06-17\/index$/,
    /\/reports\/arm-batch-grammar-2026-06-17\/index$/,
    /loop-engineering$/,
    /^\.\/\.$/,
    /README$/,
  ],
});
