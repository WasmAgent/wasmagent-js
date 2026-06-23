# Skills & Lifecycle Hooks

> **A3** — progressive disclosure for instructions and tools, plus a
> post-tool hook chain for audit/redaction/normalisation. Aligned with the
> Claude Agent SDK SKILL.md / CrewAI v1.12 / Pydantic AI Capabilities
> convention that the 2026 framework round all converged on.

wasmagent-js already had `deferLoading` for tool schemas. A3 generalises
that idea to **whole skill bundles** (instructions + tools), and adds a
**post-tool hook** sibling to the existing `ToolGuardrail` (which acts as
a pre-tool hook).

---

## Skills

A skill is `(name, description, trigger, lazyBody)` where `lazyBody`
yields the actual `(instructions, tools)` only when the skill is
activated. Until then, the agent only sees the description — short
text, never bloats the prompt.

### Quick start

```ts
import { SkillRegistry } from "@wasmagent/core";

const registry = new SkillRegistry();

registry.register({
  name: "react-build",
  description: "Scaffold a React + Vite + TypeScript app",
  trigger: (task) => /react|vite/i.test(task),
  load: async () => ({
    instructions: `
      ## Phase 1: Plan
      Wrap your plan in <boltThinking> tags…
      ## Phase 2: Generate Files
      1. package.json   2. vite.config.ts   3. index.html …
    `,
    tools: [scaffoldReactTool, lintReactTool],
  }),
});

// Per-task resolution — match triggers, lazily load matched bodies.
const resolved = await registry.resolveForTask(task);
if (resolved) {
  systemPrompt += "\n\n" + resolved.instructions;
  tools.push(...resolved.tools);
}
```

### API

```ts
class SkillRegistry {
  register(skill: Skill): void;
  list(): SkillManifest[];                 // hot — descriptions only
  describe(): string;                       // markdown bullet list
  match(task: string): Promise<SkillManifest[]>;
  activate(name: string): Promise<ActivationResult>;  // loads body lazily, caches
  resolveForTask(task: string):
    Promise<{ instructions: string; tools: ToolDefinition[]; activated: string[] } | null>;
}
```

### When to use which

- **`trigger`**: cheap predicate. The matcher runs it on every task; for
  thousands of skills, prefer string regex / token presence checks. For
  LLM-routed activation, wrap a small classifier model in a closure but
  remember it costs an inference per task.
- **No trigger**: the skill is "explicit-only" — only loaded when the
  host app calls `activate(name)` directly. Useful for opt-in workflows
  the user toggles in the UI.
- **`tags`**: optional, surfaced in `list()` — handy for dashboards.

### What this is NOT

- Skills are **not** Claude SDK MCP servers. Both can extend an agent;
  skills are bundled with the run, MCP servers are external processes.
  Use both together when it makes sense.
- Skills are **not** subagents. A subagent is its own run (separate
  `run()` invocation, separate event stream); a skill is a piece of the
  current run's prompt and tool registry.

---

## Lifecycle hooks (pre / post tool)

Pre-tool hooks already existed as `ToolGuardrail` — they can BLOCK a
tool call by returning `tripwireTriggered: true`. Post-tool hooks are
the new sibling: they observe AFTER the tool ran, and may rewrite the
output before the agent sees it.

### Why two layers, not one

Pre-hooks gate; post-hooks transform. Mixing them confuses the
intent — `denyTools(...)` and `redactPostHook(...)` have very different
"this firing means" semantics. Keeping them separate makes the model
explicit.

### Post-hook contract

```ts
interface ToolPostHook {
  readonly name: string;
  after(toolName: string, ctx: ToolPostHookContext):
    | Promise<void | { rewrite: unknown }>
    | void
    | { rewrite: unknown };
}
```

- Return `undefined` → leave the output unchanged (audit / log only).
- Return `{ rewrite: <new> }` → the agent sees `<new>` instead.
- Hooks compose — each rewrite feeds the next hook in registration order.
- Errors thrown by a hook are logged but do NOT propagate.

### Built-in hooks

```ts
import { redactPostHook, truncatePostHook } from "@wasmagent/core";

// Replace API keys with [REDACTED]
const redact = redactPostHook({ pattern: /sk-[a-z0-9]{6,}/gi });

// Trim huge tool outputs to last 4 KB
const truncate = truncatePostHook({ maxChars: 4_000 });

// Use in a runner:
import { runToolPostHooks } from "@wasmagent/core";
const safe = await runToolPostHooks([redact, truncate], toolName, rawOut, {
  input,
  durationMs,
});
```

### Wiring in an agent run

The hooks are pure functions; wire them into your tool-call loop right
after the tool resolves:

```ts
const rawOutput = await tool.forward(input);
const finalOutput = await runToolPostHooks(
  postHooks,
  tool.name,
  rawOutput,
  { input, durationMs: Date.now() - start, originalTask },
);
assembler.addStep({ type: "tool_call", toolName, toolInput: input, toolOutput: finalOutput });
```

---

## See also

- `packages/core/src/skills/Skill.ts` — registry implementation
- `packages/core/src/skills/Skill.test.ts` — 9 tests cover lazy load,
  cache, multi-skill compose, flaky-trigger isolation, dup detection
- `packages/core/src/guardrails/index.ts` — `ToolPostHook` + builtin
  helpers (redact, truncate)
- `packages/core/src/guardrails/index.test.ts` — 7 post-hook tests
- [agent-prompts/](../../packages/agent-prompts/) — composable prompt
  fragments; pair with skills for the full system-prompt story
