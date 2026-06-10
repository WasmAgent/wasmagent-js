/**
 * Browser-automation example: launch Chromium, navigate to a URL,
 * extract the title + main heading, take a screenshot.
 *
 * Required:
 *   bun add playwright
 *   ANTHROPIC_API_KEY=...
 */
import { writeFile } from "node:fs/promises";
import { ToolCallingAgent } from "@agentkit-js/core";
import { AnthropicModel } from "@agentkit-js/model-anthropic";
import {
  buildBrowserTools,
  openPlaywrightSession,
} from "@agentkit-js/tools-browser";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const session = await openPlaywrightSession({ headless: true });
  try {
    const tools = Object.values(buildBrowserTools(session));
    const model = new AnthropicModel("claude-sonnet-4-6", apiKey);
    const agent = new ToolCallingAgent({ tools, model, maxSteps: 6 });

    const task = `
      Navigate to https://example.com, extract the page heading (selector "h1"),
      then take a fullpage screenshot. Report what you found.
    `.trim();

    let screenshotDataUrl = null;
    for await (const ev of agent.run(task)) {
      if (ev.event === "tool_call" && ev.channel === "tool") {
        console.log(`→ ${ev.data.toolName}(${JSON.stringify(ev.data.args).slice(0, 100)})`);
      } else if (ev.event === "tool_result" && ev.channel === "tool") {
        if (ev.data.toolName === "screenshot" && ev.data.output?.dataUrl) {
          screenshotDataUrl = ev.data.output.dataUrl;
        }
      } else if (ev.event === "final_answer" && ev.channel === "text") {
        console.log("\n=== Agent's report ===\n" + ev.data.answer);
      }
    }

    if (screenshotDataUrl) {
      const b64 = screenshotDataUrl.split(",")[1];
      await writeFile("./screenshot.png", Buffer.from(b64, "base64"));
      console.log("\n📸 Screenshot saved to ./screenshot.png");
    }
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
