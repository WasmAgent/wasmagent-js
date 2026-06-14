import { defineConfig } from "vitepress";

const enNav = [
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
  { text: "GitHub", link: "https://github.com/telleroutlook/agentkit-js" },
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
  ],

  "/kernels/": [
    {
      text: "Sandboxed code execution",
      items: [
        { text: "Decision tree & comparison", link: "/kernels/comparison" },
      ],
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
  { text: "GitHub", link: "https://github.com/telleroutlook/agentkit-js" },
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
      items: [
        { text: "决策树与对比", link: "/zh/kernels-comparison" },
      ],
    },
  ],
};

export default defineConfig({
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
          pattern: "https://github.com/telleroutlook/agentkit-js/edit/main/docs/:path",
          text: "在 GitHub 上编辑此页",
        },
      },
    },
  },

  themeConfig: {
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

  srcExclude: ["**/node_modules/**", "**/dist/**", "**/.vitepress/cache/**"],

  // Some guides link to `../../examples/*` and `../../packages/*` paths that exist
  // in the repository but are outside the docs site. Allow those.
  ignoreDeadLinks: [/examples\//, /packages\//],
});
