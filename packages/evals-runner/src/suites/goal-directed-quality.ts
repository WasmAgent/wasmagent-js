/**
 * goal-directed-quality — does GoalDirectedAgent actually rescue prose
 * tasks that one-shot ToolCallingAgent fails on?
 *
 * Origin: a bscode user asked the agent to write a Chinese-language
 * technical introduction. With a one-shot tool-call run, the model
 * saved a 718-byte outline and called it done — the user wanted a
 * 1500+ char document with substantive sections (see [[bscode-md-as-card-2026-06-18]]).
 *
 * This suite pins down the fix:
 *   1. `tech-intro-zh`: write a technical introduction in Chinese.
 *      Pass criteria: file exists, ≥1500 字 by `word_count_min`, ≥4 H2
 *      headings.
 *   2. `readme-en`: draft an English README. Pass criteria: file exists,
 *      ≥600 words, ≥4 sections, contains "## Installation" or
 *      equivalent.
 *   3. `code-task`: refactor a debounce function. Pass criteria: file
 *      exists with the new shape — short docs are fine here, the agent
 *      should NOT pad code with prose.
 *
 * The third item is the regression guard: GoalDirectedAgent's
 * synthesised criteria adapt to the task. A code task should produce
 * code-flavoured criteria, not prose-flavoured ones. If the synth
 * model over-fits to "writing tasks need ≥1500 chars" it will fail this
 * item.
 *
 * Each item runs a real `GoalDirectedAgent` against the model under
 * test. The judge model defaults to the executor model — operators who
 * want stronger grading can pass `--judgeModel <id>` (a future runner
 * flag; for now everything goes through one model).
 *
 * ## Cost
 *
 * On sonnet-4.6 each item is roughly:
 *   - 1 synth call (~1-2k tokens out)
 *   - 1-2 executor iterations (5-15 steps each)
 *   - 3 judge calls per llm_judge criterion per iteration
 * → ~$0.15-$0.40 per item. 3 items → < $1.50 per full run. Don't run on
 * hand-crank schedules; run when GoalDirectedAgent or its prompts
 * change.
 */

import type { Model, ToolDefinition } from "@wasmagent/core";
import { GoalDirectedAgent, type WorkspaceReader } from "@wasmagent/core";
import { GenericOpenAICompatModel } from "@wasmagent/models";
import { z } from "zod";
import type { BenchmarkItem, BenchmarkSuite, ModelSpec, RunItemResult } from "../types.js";

interface ItemMeta {
  /** Final-pass criteria the suite checks externally — independent of the agent's own criteria. */
  externalCriteria: Array<{
    description: string;
    check: (ws: WorkspaceReader) => Promise<boolean>;
  }>;
  /** Path the agent is expected to write. */
  expectedPath: string;
}

const ITEM_META: Record<string, ItemMeta> = {
  "tech-intro-zh": {
    expectedPath: "intro.md",
    externalCriteria: [
      {
        description: "file exists",
        check: (ws) => ws.fileExists("intro.md"),
      },
      {
        description: "≥1500 字",
        check: async (ws) => {
          if (!(await ws.fileExists("intro.md"))) return false;
          const body = await ws.readFile("intro.md");
          const cjk = body.match(/[一-鿿]/gu) ?? [];
          return cjk.length >= 1500;
        },
      },
      {
        description: "≥4 H2 headings",
        check: async (ws) => {
          if (!(await ws.fileExists("intro.md"))) return false;
          const body = await ws.readFile("intro.md");
          const headings = body.match(/^##\s/gm) ?? [];
          return headings.length >= 4;
        },
      },
    ],
  },
  "readme-en": {
    expectedPath: "README.md",
    externalCriteria: [
      {
        description: "file exists",
        check: (ws) => ws.fileExists("README.md"),
      },
      {
        description: "≥600 words",
        check: async (ws) => {
          if (!(await ws.fileExists("README.md"))) return false;
          const body = await ws.readFile("README.md");
          const words = body.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
          return words.length >= 600;
        },
      },
      {
        description: "≥4 sections",
        check: async (ws) => {
          if (!(await ws.fileExists("README.md"))) return false;
          const body = await ws.readFile("README.md");
          const headings = body.match(/^##?\s/gm) ?? [];
          return headings.length >= 4;
        },
      },
    ],
  },
  "code-task": {
    expectedPath: "debounce.ts",
    externalCriteria: [
      {
        description: "file exists",
        check: (ws) => ws.fileExists("debounce.ts"),
      },
      {
        description: "exports debounce function with delay arg",
        check: async (ws) => {
          if (!(await ws.fileExists("debounce.ts"))) return false;
          const body = await ws.readFile("debounce.ts");
          return /export\s+function\s+debounce/.test(body) && /\bdelay\b/.test(body);
        },
      },
    ],
  },
};

const ITEMS: BenchmarkItem[] = [
  {
    id: "tech-intro-zh",
    task: "写一篇 1500 字以上的技术介绍，主题是 OAuth 2.0 协议（中文）。保存为 intro.md。要求覆盖原理、流程、典型场景、安全考虑。",
    expectedAnswer: "verified",
    category: "prose",
  },
  {
    id: "readme-en",
    task: "Draft a comprehensive README.md for an open-source CLI that lints YAML files. Sections should cover what it does, installation, usage, configuration, examples. ≥600 words.",
    expectedAnswer: "verified",
    category: "prose",
  },
  {
    id: "code-task",
    task: "Write a TypeScript debounce function that takes (fn, delay) and returns a debounced wrapper. Save it to debounce.ts.",
    expectedAnswer: "verified",
    category: "code",
  },
];

function buildModel(spec: ModelSpec): Model {
  return new GenericOpenAICompatModel(spec.modelId ?? spec.id, spec.baseUrl, {
    apiKey: spec.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "stub",
  });
}

/**
 * Minimal in-memory WorkspaceReader + a write_file tool that mutates it.
 * Lets the eval run end-to-end without needing a CF KV or Node fs.
 */
function buildHarness(): {
  ws: WorkspaceReader;
  tools: ToolDefinition[];
} {
  const data = new Map<string, string>();
  const ws: WorkspaceReader = {
    async readFile(path) {
      const v = data.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async fileExists(path) {
      return data.has(path);
    },
    async fileSize(path) {
      const v = data.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(v).length;
    },
  };
  const writeFile: ToolDefinition<{ path: string; content: string }, { ok: true }> = {
    name: "write_file",
    description: "Create or overwrite a file at the given path with the supplied content.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    readOnly: false,
    idempotent: true,
    async forward({ path, content }: { path: string; content: string }) {
      data.set(path, content);
      return { ok: true as const };
    },
  };
  const readFile: ToolDefinition<{ path: string }, { content: string } | { error: string }> = {
    name: "read_file",
    description: "Read the current contents of a file.",
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.union([z.object({ content: z.string() }), z.object({ error: z.string() })]),
    readOnly: true,
    idempotent: true,
    async forward({ path }: { path: string }) {
      if (!data.has(path)) return { error: `ENOENT: ${path}` };
      return { content: data.get(path) ?? "" };
    },
  };
  return { ws, tools: [writeFile, readFile] };
}

async function runOne(args: { item: BenchmarkItem; model: ModelSpec }): Promise<RunItemResult> {
  const { item, model } = args;
  const meta = ITEM_META[item.id];
  if (!meta) return { answer: null, passed: false, error: `no fixture for ${item.id}` };

  const exec = buildModel(model);
  const { ws, tools } = buildHarness();
  const startMs = Date.now();
  const agent = new GoalDirectedAgent({
    model: exec,
    tools,
    workspaceReader: ws,
    scout: {
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
      workspaceEntries: [],
    },
    maxIterations: 3,
    maxStepsPerIteration: 12,
  });
  let outcome: string | undefined;
  try {
    for await (const ev of agent.run(item.task)) {
      if (ev.event === ("goal_directed_done" as never)) {
        outcome = (ev.data as { outcome?: string }).outcome;
      }
    }
  } catch (e) {
    return {
      answer: null,
      passed: false,
      error: e instanceof Error ? e.message : String(e),
      wallMs: Date.now() - startMs,
    };
  }

  // External judgement — independent of the agent's self-graded outcome.
  // This is the layer that tells us whether the synth+judge inside the
  // agent matched ground truth or just rubber-stamped its own work.
  const failures: string[] = [];
  for (const c of meta.externalCriteria) {
    let ok = false;
    try {
      ok = await c.check(ws);
    } catch {
      ok = false;
    }
    if (!ok) failures.push(c.description);
  }
  const passed = failures.length === 0;
  return {
    answer: outcome ?? "unknown",
    passed,
    wallMs: Date.now() - startMs,
    ...(passed
      ? {}
      : { error: `external criteria failed: ${failures.join(", ")} (agent outcome: ${outcome})` }),
  };
}

export const goalDirectedQualitySuite: BenchmarkSuite = {
  name: "goal-directed-quality",
  title: "Goal-Directed Agent — Output Quality",
  description:
    "End-to-end check that GoalDirectedAgent rescues prose tasks (≥1500 字 / ≥600 words / structured sections) without over-engineering simple code tasks. Live LLM run; expect ~$0.50–1.50 per full pass.",
  items: ITEMS,
  scorers: [],
  runItem: runOne,
};

export const __test__ = {
  ITEMS,
  ITEM_META,
};
