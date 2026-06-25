import { defineConfig } from "vitepress";

const enNav = [
  { text: "Guide", link: "/guides/getting-started" },
  { text: "Trust Pack", link: "/quickstarts/trust-pack-30min" },
  {
    text: "Security",
    items: [
      { text: "MCP Firewall", link: "/security/mcp-firewall-attack-demos" },
      { text: "AEP Contract", link: "/aep-contract" },
      { text: "Security governance pack", link: "/security-governance-pack/README" },
    ],
  },
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
        { text: "Trust Pack (30 min end-to-end)", link: "/quickstarts/trust-pack-30min" },
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
        { text: "DevTools cross-framework debug", link: "/guides/devtools-cross-framework" },
        { text: "Goal-directed agent", link: "/guides/goal-directed" },
        { text: "Workflow engine", link: "/guides/workflows" },
        { text: "Code Mode (MCP token –85%)", link: "/guides/code-mode" },
        { text: "Evals cookbook", link: "/guides/evals-cookbook" },
        { text: "Evals runner", link: "/guides/evals-runner" },
        { text: "Quality runners", link: "/guides/quality-runners" },
        { text: "Super instruction set", link: "/guides/super-instruction-set" },
        { text: "MCP server", link: "/guides/mcp-server" },
        { text: "MCP deferred loading (–85 %)", link: "/guides/mcp-deferred-loading" },
        { text: "OpenAI-compat recipes", link: "/guides/openai-compat-recipes" },
        { text: "AGENTS.md project conventions", link: "/guides/agents-md" },
      ],
    },
    {
      text: "Integrate",
      items: [
        { text: "Use kernels with Vercel AI SDK", link: "/guides/integrate-vercel-ai-sdk" },
        { text: "Use kernels with Mastra", link: "/guides/integrate-mastra" },
        { text: "Claude Agent SDK", link: "/guides/integrate-claude-agent-sdk" },
        { text: "OpenAI Agents JS", link: "/guides/integrate-openai-agents" },
      ],
    },
    {
      text: "Security & evidence",
      items: [
        { text: "MCP firewall attack demos", link: "/security/mcp-firewall-attack-demos" },
        { text: "OWASP Agentic mapping", link: "/security/capability-manifest-owasp" },
        { text: "AEP schema contract", link: "/aep-contract" },
        { text: "Install footprint", link: "/distribution/install-footprint" },
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
        { text: "Memory 概览与决策树", link: "/zh/guides/memory" },
        { text: "Memory 模式", link: "/zh/guides/memory-patterns" },
        { text: "观察记忆", link: "/zh/guides/observational-memory" },
        { text: "Skills & 生命周期 hook", link: "/zh/guides/skills-and-hooks" },
        { text: "DevTools 时间旅行", link: "/zh/guides/devtools" },
        { text: "DevTools 跨框架调试", link: "/zh/guides/devtools-cross-framework" },
        { text: "目标导向 Agent", link: "/zh/guides/goal-directed" },
        { text: "工作流引擎", link: "/zh/guides/workflows" },
        { text: "Code Mode（MCP token 压缩）", link: "/zh/guides/code-mode" },
        { text: "Evals 实战手册", link: "/zh/guides/evals-cookbook" },
        { text: "MCP server", link: "/zh/guides/mcp-server" },
        { text: "MCP 延迟加载（–85%）", link: "/zh/guides/mcp-deferred-loading" },
        { text: "AGENTS.md 项目约定", link: "/zh/guides/agents-md" },
        { text: "OpenAI 兼容配方", link: "/zh/guides/openai-compat-recipes" },
      ],
    },
    {
      text: "集成",
      items: [
        { text: "Vercel AI SDK", link: "/zh/guides/integrate-vercel-ai-sdk" },
        { text: "Mastra", link: "/zh/guides/integrate-mastra" },
        { text: "Claude Agent SDK", link: "/zh/guides/integrate-claude-agent-sdk" },
        { text: "OpenAI Agents JS", link: "/zh/guides/integrate-openai-agents" },
      ],
    },
    {
      text: "RLAIF 数据流水线",
      items: [
        { text: "RLAIF rollout 流水线", link: "/zh/guides/rlaif-rollout" },
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
    "WasmAgent adds a verifiable evidence layer to agent tool use: protect tool calls, record what happened, audit the result, and turn trusted traces into training data.",
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
          "WasmAgent adds a verifiable evidence layer to agent tool use: protect tool calls, record what happened, audit the result, and turn trusted traces into training data.",
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
