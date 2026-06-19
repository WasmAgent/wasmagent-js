/**
 * Approval policy for write-class tools.
 *
 * Wraps existing write tools (write_file, patch_file, delete_file,
 * rename_file) with a `needsApproval` function so the HITL gate fires on
 * paths or sizes that match the configured policy and skips everything else.
 *
 * Defaults are conservative — the bare policy with NO rules is "approve
 * everything". A consumer adds rules until the gate matches their threat
 * model. Paths are matched as prefixes; size rules apply per single tool
 * call (content length, patch delta).
 */

import type { ToolDefinition } from "../tools/types.js";

export type WriteOpKind = "write" | "patch" | "delete" | "rename";

/**
 * One rule: gates a class of operations. Multiple rules are evaluated
 * in registration order; the FIRST matching rule decides. A rule that
 * matches but evaluates to false short-circuits — subsequent rules
 * cannot re-add approval. This makes "always allow this path even if
 * later rules would block it" expressible.
 */
export interface ApprovalRule {
  /** Stable id for the rule — surfaced in audit logs. */
  id: string;
  /**
   * Match the rule against the operation? When `op` is omitted, the
   * rule applies to ALL ops. When `paths` is omitted, the rule
   * applies to all paths. The path is the primary `path` (or `from`
   * for rename) of the call.
   */
  match?: {
    op?: WriteOpKind | WriteOpKind[];
    paths?: string[];
    /** Min size in chars that the op must hit before the rule fires. */
    minSizeChars?: number;
  };
  /**
   * Final verdict when this rule matches:
   *   - "require" — the operation needs approval
   *   - "allow"   — short-circuit; no approval needed regardless of later rules
   */
  verdict: "require" | "allow";
}

export interface ApprovalPolicyOptions {
  /**
   * What to do when NO rule matches. Default: "allow" — write tools run
   * without approval. Set to "require" to make approval the default and
   * use rules as exceptions.
   */
  defaultVerdict?: "require" | "allow";
  rules: ApprovalRule[];
}

interface ApprovalQuery {
  op: WriteOpKind;
  path: string;
  sizeChars: number;
}

export class ApprovalPolicy {
  readonly #rules: ApprovalRule[];
  readonly #default: "require" | "allow";

  constructor(opts: ApprovalPolicyOptions) {
    this.#rules = [...opts.rules];
    this.#default = opts.defaultVerdict ?? "allow";
  }

  /** Decide whether the given op needs approval. Sync — no I/O involved. */
  needsApproval(query: ApprovalQuery): boolean {
    for (const rule of this.#rules) {
      if (!ApprovalPolicy.#matches(rule, query)) continue;
      return rule.verdict === "require";
    }
    return this.#default === "require";
  }

  /** Test seam — surface the matched rule id for audit logs / debugging. */
  explain(query: ApprovalQuery): { ruleId: string | null; verdict: "require" | "allow" } {
    for (const rule of this.#rules) {
      if (!ApprovalPolicy.#matches(rule, query)) continue;
      return { ruleId: rule.id, verdict: rule.verdict };
    }
    return { ruleId: null, verdict: this.#default };
  }

  static #matches(rule: ApprovalRule, query: ApprovalQuery): boolean {
    const m = rule.match;
    if (!m) return true;
    if (m.op !== undefined) {
      const ops = Array.isArray(m.op) ? m.op : [m.op];
      if (!ops.includes(query.op)) return false;
    }
    if (m.paths !== undefined && m.paths.length > 0) {
      const matchPath = m.paths.some(
        (p) => query.path === p || query.path.startsWith(`${p}/`) || query.path.startsWith(p)
      );
      if (!matchPath) return false;
    }
    if (m.minSizeChars !== undefined && query.sizeChars < m.minSizeChars) {
      return false;
    }
    return true;
  }
}

// ── Tool wrappers ────────────────────────────────────────────────────────────
//
// Each helper takes an existing ToolDefinition and returns a new one with
// `needsApproval` set to a policy-driven function. Other behaviour is
// unchanged — we deliberately do NOT re-implement the underlying tools to
// avoid drift.

interface PathOnly {
  path: string;
}
interface PatchInput {
  path: string;
  patch: string;
}
interface RenameInput {
  from: string;
  to: string;
}
interface WriteInput {
  path: string;
  content: string;
}

function applyPolicy<I, O>(
  tool: ToolDefinition<I, O>,
  op: WriteOpKind,
  policy: ApprovalPolicy,
  pickPath: (input: I) => string,
  pickSize: (input: I) => number
): ToolDefinition<I, O> {
  return {
    ...tool,
    needsApproval: (input: I) =>
      policy.needsApproval({
        op,
        path: pickPath(input),
        sizeChars: pickSize(input),
      }),
  } as ToolDefinition<I, O>;
}

/**
 * Wrap write-class tools (write_file / patch_file / delete_file / rename_file)
 * with a `needsApproval` function driven by the given policy. Other tools are
 * returned unchanged.
 */
export function applyApprovalPolicy(
  policy: ApprovalPolicy,
  tools: ToolDefinition[]
): ToolDefinition[] {
  return tools.map((t) => {
    switch (t.name) {
      case "write_file":
        return applyPolicy(
          t as unknown as ToolDefinition<WriteInput, string>,
          "write",
          policy,
          (i) => i.path,
          (i) => i.content?.length ?? 0
        ) as unknown as ToolDefinition;
      case "patch_file":
        return applyPolicy(
          t as unknown as ToolDefinition<PatchInput, string>,
          "patch",
          policy,
          (i) => i.path,
          (i) => i.patch?.length ?? 0
        ) as unknown as ToolDefinition;
      case "delete_file":
        return applyPolicy(
          t as unknown as ToolDefinition<PathOnly, string>,
          "delete",
          policy,
          (i) => i.path,
          () => 0
        ) as unknown as ToolDefinition;
      case "rename_file":
        return applyPolicy(
          t as unknown as ToolDefinition<RenameInput, string>,
          "rename",
          policy,
          (i) => i.from,
          () => 0
        ) as unknown as ToolDefinition;
      default:
        return t;
    }
  });
}

/**
 * Ready-to-use policy presets. Pick one and pass it to `applyApprovalPolicy`.
 */
export const PolicyPresets = {
  /** Nothing needs approval — suitable for dev sandboxes. */
  permissive(): ApprovalPolicy {
    return new ApprovalPolicy({ rules: [], defaultVerdict: "allow" });
  },
  /** Every write needs approval — suitable for production. */
  strict(): ApprovalPolicy {
    return new ApprovalPolicy({ rules: [], defaultVerdict: "require" });
  },
  /**
   * Middle ground: dotfiles, env files, and CI configs always require
   * approval; large bulk writes (> 5 KB) require approval; small source-file
   * edits run free.
   */
  balanced(): ApprovalPolicy {
    return new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [
        {
          id: "dotfiles-require-approval",
          match: {
            paths: [
              ".env",
              ".env.production",
              ".env.local",
              ".dev.vars",
              ".github/",
              "wrangler.toml",
            ],
          },
          verdict: "require",
        },
        {
          id: "delete-always-requires-approval",
          match: { op: ["delete", "rename"] },
          verdict: "require",
        },
        {
          id: "large-writes-require-approval",
          match: { op: ["write"], minSizeChars: 5_000 },
          verdict: "require",
        },
      ],
    });
  },
};
