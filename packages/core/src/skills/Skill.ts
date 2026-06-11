/**
 * A3 — Agent Skills.
 *
 * A "skill" is a bundle of (description, instructions, tools) the agent can
 * use when a task matches its trigger. Skills are NOT loaded eagerly: only
 * a skill's `description` is exposed up-front. The agent (or a programmatic
 * matcher) decides which skill applies to the current task; only then do we
 * inline the full `instructions` and register the skill's `tools`.
 *
 * This mirrors the Claude Agent SDK SKILL.md model and CrewAI v1.12 /
 * Pydantic AI Capabilities — the convergent 2026 abstraction across major
 * frameworks. agentkit-js' deferLoading mechanism (tool schemas hidden
 * until referenced) already does the equivalent for tools; this layer
 * extends progressive disclosure to instructions too.
 *
 * The class is dependency-light: it works with any tool-shaped object
 * (we only need `name`), so consumers don't have to commit to one Tool
 * type definition. The actual agent integration is ToolRegistry-side and
 * left to the host application — see the example for one wiring.
 */

import type { ToolDefinition } from "../tools/types.js";

/**
 * Trigger function — given the user's task text, return true if this
 * skill should be activated for the run. Keep it cheap; this fires on
 * every task. For LLM-based triggering, wrap a small model in a closure.
 */
export type SkillTrigger = (task: string) => boolean | Promise<boolean>;

/** Compact metadata exposed to the agent up-front (the "advert"). */
export interface SkillManifest {
  /** Stable id used in toolings, persistence, telemetry. */
  name: string;
  /** One-sentence "what does this skill do" — used by the matcher / LLM. */
  description: string;
  /** Optional tags for grouping / filtering in dashboards. */
  tags?: string[];
}

/** Full skill definition. The runtime keeps only the manifest hot. */
export interface Skill extends SkillManifest {
  /**
   * Predicate matching tasks this skill should activate for. When omitted,
   * the skill is only activated explicitly via `registry.activate(name)`.
   */
  trigger?: SkillTrigger;
  /**
   * Loader for the skill's body. Called the first time the skill is
   * activated; results are cached for subsequent activations within the
   * same registry instance. Lazy on purpose — a skill with a big
   * instructions block costs nothing until used.
   */
  load: () => Promise<SkillBody> | SkillBody;
}

/** What `load()` returns — the actual stuff that gets injected into the run. */
export interface SkillBody {
  /**
   * Long-form instructions appended to the agent's system prompt when the
   * skill is active. The Claude Agent SDK convention is one paragraph
   * describing when to use it, then bullet-list rules. Match it.
   */
  instructions: string;
  /**
   * Tools the skill brings to the run. They're added to the agent's tool
   * registry on activation; they're absent otherwise — perfect for keeping
   * the up-front tool schema small (the same reason deferLoading exists).
   */
  tools?: ToolDefinition[];
}

/** Result of a `match()` call — the activated skill plus its loaded body. */
export interface ActivationResult {
  manifest: SkillManifest;
  body: SkillBody;
}

/**
 * In-memory registry. One instance per agent run. Holds skill manifests
 * up-front, loads bodies on demand, and exposes a tiny matcher API.
 */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();
  readonly #cache = new Map<string, SkillBody>();

  /** Register a skill. Re-registering with the same name throws. */
  register(skill: Skill): void {
    if (this.#skills.has(skill.name)) {
      throw new Error(`Skill "${skill.name}" already registered`);
    }
    this.#skills.set(skill.name, skill);
  }

  /** Read-only list of every registered manifest. */
  list(): SkillManifest[] {
    return [...this.#skills.values()].map(({ name, description, tags }) => ({
      name,
      description,
      ...(tags ? { tags } : {}),
    }));
  }

  /** Render the registry as a markdown bullet list — handy for system prompts. */
  describe(): string {
    if (this.#skills.size === 0) return "(no skills registered)";
    return [...this.#skills.values()]
      .map((s) => `- **${s.name}** — ${s.description}`)
      .join("\n");
  }

  /**
   * Run every skill's trigger against the task. Returns the manifests of
   * matched skills in registration order. Skills without a trigger are
   * skipped — they must be activated explicitly. The matcher does NOT
   * load bodies; call `activate(name)` for that.
   */
  async match(task: string): Promise<SkillManifest[]> {
    const out: SkillManifest[] = [];
    for (const skill of this.#skills.values()) {
      if (!skill.trigger) continue;
      try {
        if (await skill.trigger(task)) {
          out.push({ name: skill.name, description: skill.description, ...(skill.tags ? { tags: skill.tags } : {}) });
        }
      } catch (err) {
        // A flaky trigger should not crash the run; treat as no-match.
        console.warn(`[skills] trigger threw for ${skill.name}:`, err);
      }
    }
    return out;
  }

  /**
   * Load (or fetch from cache) the body for one skill and return it together
   * with the manifest. Throws if the name is unknown.
   */
  async activate(name: string): Promise<ActivationResult> {
    const skill = this.#skills.get(name);
    if (!skill) throw new Error(`Skill "${name}" not registered`);
    let body = this.#cache.get(name);
    if (!body) {
      body = await skill.load();
      this.#cache.set(name, body);
    }
    return {
      manifest: { name: skill.name, description: skill.description, ...(skill.tags ? { tags: skill.tags } : {}) },
      body,
    };
  }

  /**
   * Convenience: match → activate every match → merge instructions and
   * tools. Returns null when nothing matched (caller proceeds with the
   * default prompt + tools).
   */
  async resolveForTask(
    task: string,
  ): Promise<{ instructions: string; tools: ToolDefinition[]; activated: string[] } | null> {
    const matched = await this.match(task);
    if (matched.length === 0) return null;
    const activated: string[] = [];
    const instructionParts: string[] = [];
    const tools: ToolDefinition[] = [];
    for (const m of matched) {
      const r = await this.activate(m.name);
      activated.push(r.manifest.name);
      instructionParts.push(`### Skill: ${r.manifest.name}\n${r.body.instructions}`);
      if (r.body.tools) tools.push(...r.body.tools);
    }
    return {
      instructions: instructionParts.join("\n\n"),
      tools,
      activated,
    };
  }
}
