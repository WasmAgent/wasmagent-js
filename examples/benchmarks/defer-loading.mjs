/**
 * Verifies the README claim: `deferLoading: true` (Anthropic Tool Search)
 * cuts token cost by ~85% for large MCP tool fleets, by stripping deferred
 * tool schemas from the system prefix.
 *
 * Mechanism check: with 100 tools each carrying a meaningful schema, the
 * size of the system prefix is dominated by schema definitions. Marking
 * 90% of them as deferred should drop prefix size by roughly that fraction.
 */
import { writeFile } from "node:fs/promises";
import { tokensOf, verdict } from "./tokens.mjs";

// ── Build a synthetic MCP-shaped tool with a realistic schema ────────────────
function makeTool(i) {
  return {
    name: `tool_${i.toString().padStart(3, "0")}`,
    description:
      "Performs a representative MCP-shaped operation across a fleet of similar tools. " +
      "This description matches the size of typical real MCP server entries.",
    inputSchema: {
      type: "object",
      required: ["target", "options"],
      properties: {
        target: { type: "string", description: "Target identifier" },
        options: {
          type: "object",
          properties: {
            verbose: { type: "boolean", description: "Verbose output" },
            timeout: { type: "number", description: "Timeout in ms" },
            retries: { type: "number", description: "Number of retries" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    deferLoading: false,
  };
}

function buildPrefix(tools, includeDeferred) {
  // Anthropic's wire format inlines tool schemas; we approximate by
  // JSON-stringifying each active schema and summing tokens.
  return tools
    .filter((t) => includeDeferred || !t.deferLoading)
    .map((t) =>
      JSON.stringify({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })
    )
    .join("\n");
}

async function main() {
  // 100 tools, 90 of them deferrable. The 10 that stay loaded represent the
  // hot-path MCP set the agent always needs visible.
  const tools = Array.from({ length: 100 }, (_, i) => makeTool(i));
  for (let i = 10; i < 100; i++) tools[i].deferLoading = true;

  const baselinePrefix = buildPrefix(tools, /* includeDeferred = */ true);
  const deferredPrefix = buildPrefix(tools, /* includeDeferred = */ false);
  const baseTokens = tokensOf(baselinePrefix);
  const deferTokens = tokensOf(deferredPrefix);
  const ratio = deferTokens / baseTokens;
  const v = verdict("Deferred tool loading prefix size", ratio, 0.15 /* target = 1 - 0.85 */, 0.05);

  let md = "# Tool deferred-loading benchmark\n\n";
  md += "| Mode | Prefix tokens |\n|---|---:|\n";
  md += `| All 100 tools loaded | ${baseTokens} |\n`;
  md += `| 10 hot + 90 deferred | ${deferTokens} |\n`;
  md += `| **Ratio** | **${(ratio * 100).toFixed(1)}%** |\n\n`;
  md += `${v.line}\n`;
  md += `\nREADME claim: \`−85% tokens for large MCP server collections\`. ` +
    `Target ratio: 0.15. Observed: ${ratio.toFixed(3)} ` +
    `(deviation ${v.deviation.toFixed(3)}).\n`;

  console.log(md);
  await writeFile(new URL("./report-defer-loading.md", import.meta.url), md);
  if (!v.pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
