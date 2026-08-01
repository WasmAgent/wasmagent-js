import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGuardPolicy, redactGuardReport } from "./policy.js";

describe("parseGuardPolicy", () => {
  it("turns allow, approval, and deny entries into gateway rules", () => {
    const policy = parseGuardPolicy(`
allow:
  - filesystem.read
require_approval:
  - shell.exec
deny:
  - shell.rm_rf
budgets:
  max_tool_calls: 2
redaction:
  patterns:
    - token
`);

    expect(policy.mode).toBe("enforce");
    expect(policy.maxToolCalls).toBe(2);
    const evaluate = (toolName: string) =>
      policy.rules.map((rule) => rule.evaluate(toolName, {}, null));

    expect(evaluate("filesystem.read")).toEqual(["allow", undefined, undefined]);
    expect(evaluate("shell.exec")).toEqual([undefined, "ask_user", undefined]);
    expect(evaluate("shell.rm_rf")).toEqual([undefined, undefined, "deny"]);
  });

  it("rejects malformed policy values instead of silently using defaults", () => {
    expect(() => parseGuardPolicy("deny: shell.rm_rf")).toThrow("deny must be a list");
    expect(() => parseGuardPolicy("budgets:\n  max_tool_calls: -1")).toThrow(
      "budgets.max_tool_calls"
    );
  });

  it("redacts configured patterns from guard output", () => {
    expect(redactGuardReport("token leaked", ["token"])).toBe("[REDACTED] leaked");
  });

  it("makes guard enforce configured decisions and budgets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wasmagent-guard-"));
    const policyPath = join(directory, "policy.yaml");
    const toolsPath = join(directory, "tools.json");
    writeFileSync(
      policyPath,
      `mode: enforce
allow:
  - safe.read
require_approval:
  - needs.approval
deny:
  - blocked.tool
budgets:
  max_tool_calls: 3
redaction:
  patterns:
    - safe
`
    );
    writeFileSync(
      toolsPath,
      JSON.stringify([
        { name: "safe.read", description: "read safely", inputSchema: { type: "object" } },
        {
          name: "needs.approval",
          description: "requires approval",
          inputSchema: { type: "object" },
        },
        { name: "blocked.tool", description: "blocked by policy", inputSchema: { type: "object" } },
        { name: "over.budget", description: "over budget", inputSchema: { type: "object" } },
      ])
    );

    try {
      const processHandle = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "index.ts"),
          "guard",
          "--config",
          policyPath,
          "--upstream",
          toolsPath,
          "--format",
          "json",
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      const report = JSON.parse(stdout) as {
        rows: Array<{ tool: string; decision: string; reason: string }>;
      };
      expect(report.rows.map((row) => [row.tool, row.decision])).toEqual([
        ["[REDACTED].read", "allow"],
        ["needs.approval", "ask_user"],
        ["blocked.tool", "deny"],
        ["over.budget", "deny"],
      ]);
      expect(report.rows[2]?.reason).toContain("deny-config");
      expect(report.rows[3]?.reason).toContain("budget-max-tool-calls");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
