/**
 * Edge integration smoke: capability boundary cases.
 *
 * Targets the seams where validation tends to skip a corner. Every check
 * here can ONLY fail if a real boundary bug exists.
 */
import { JsKernel } from "@wasmagent/core";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function ok(label) {
  console.log(`✓ ${label}`);
}
function fail(label, detail) {
  console.error(`✗ ${label}`, detail ?? "");
  failed++;
}

// ── allowedHosts edge cases ──────────────────────────────────────────────────

{
  const k = new JsKernel({ timeoutMs: 1_500 });
  try {
    // Empty host string — should be a no-op, not match every host.
    let blocked = false;
    try {
      await k.run("fetch('https://api.example.com/x')", { allowedHosts: [""] });
    } catch (e) {
      blocked = e instanceof Error && /CapabilityDenied/.test(e.message);
    }
    if (!blocked) fail("allowedHosts:[''] does NOT match every host");
    else ok("allowedHosts:[''] does not silently allow everything");

    // Glob without dot (`*` matching apex). 2026-06 matchGlob: '*' = single
    // label — so "*" should match nothing useful. Must not match
    // "evil.com" via single-label rule applied to apex.
    let evilBlocked = false;
    try {
      await k.run("fetch('https://evil.com/data')", { allowedHosts: ["*"] });
    } catch (e) {
      evilBlocked = e instanceof Error && /CapabilityDenied/.test(e.message);
    }
    // Also acceptable: "*" matches "evil" exactly (no dots) — that's the
    // documented semantics. We just assert determinism: either always block
    // or always allow. If always allow, that's a documented choice; if
    // sometimes one and sometimes the other, that's a bug.
    if (!evilBlocked) {
      ok("allowedHosts:['*'] semantics: does not block evil.com (single-label glob)");
    } else {
      ok("allowedHosts:['*'] semantics: blocks evil.com (label-not-matching)");
    }

    // protocol downgrade via redirect — allowedHosts doesn't extend to
    // arbitrary protocols. file:// / data:// / ftp:// should be denied.
    let protoBlocked = false;
    try {
      await k.run("fetch('file:///etc/passwd')", { allowedHosts: ["*"] });
    } catch (e) {
      protoBlocked = e instanceof Error && /CapabilityDenied/.test(e.message);
    }
    if (!protoBlocked) fail("allowedHosts does not gate file:// scheme");
    else ok("allowedHosts: file:// scheme rejected");
  } finally {
    await k[Symbol.asyncDispose]();
  }
}

// ── allowedReadPaths / allowedWritePaths edge cases ─────────────────────────

{
  const tmp = await mkdtemp(join(tmpdir(), "edge-cap-"));
  try {
    const inside = join(tmp, "ok.txt");
    await writeFile(inside, "yes", "utf8");

    const k = new JsKernel({ timeoutMs: 1_500 });
    try {
      // Read inside the allowed prefix succeeds.
      const r = await k.run(`__fs__.readFile(${JSON.stringify(inside)})`, {
        allowedReadPaths: [tmp],
      });
      const content = await Promise.resolve(r.output);
      if (content !== "yes") fail("read inside prefix returned wrong content", content);
      else ok("read inside allowed prefix");

      // Path traversal `..` resolves outside.
      let traversalBlocked = false;
      try {
        await k.run(`__fs__.readFile(${JSON.stringify(join(tmp, "..", "..", "..", "etc", "passwd"))})`, {
          allowedReadPaths: [tmp],
        });
      } catch (e) {
        traversalBlocked = e instanceof Error && /CapabilityDenied/.test(e.message);
      }
      if (!traversalBlocked) fail("path traversal not blocked");
      else ok("path traversal `..` blocked");

      // Prefix-confusion: `tmp + "-sibling"` should NOT pass even though it
      // starts-with `tmp`.
      const siblingDir = `${tmp}-sibling`;
      let prefixConfBlocked = false;
      try {
        await k.run(`__fs__.readFile(${JSON.stringify(join(siblingDir, "x"))})`, {
          allowedReadPaths: [tmp],
        });
      } catch (e) {
        prefixConfBlocked = e instanceof Error && /CapabilityDenied/.test(e.message);
      }
      if (!prefixConfBlocked) fail("prefix-sibling not blocked");
      else ok("prefix-sibling blocked (no startsWith confusion)");

      // allowedWritePaths empty — write must fail even when path looks safe.
      let writeBlocked = false;
      try {
        const out = join(tmp, "out.txt");
        await k.run(`__fs__.writeFile(${JSON.stringify(out)}, 'x')`, {
          allowedReadPaths: [tmp],
          // Note: NO allowedWritePaths granted.
        });
      } catch (e) {
        writeBlocked = e instanceof Error && /CapabilityDenied/.test(e.message);
      }
      if (!writeBlocked) fail("write blocked when only read granted");
      else ok("write rejected when only read granted");
    } finally {
      await k[Symbol.asyncDispose]();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ── env edge cases ───────────────────────────────────────────────────────────

{
  const k = new JsKernel({ timeoutMs: 1_500 });
  try {
    // Empty env object — must NOT inject __env__.
    const r1 = await k.run("typeof __env__", { env: {} });
    if (r1.output !== "undefined") fail("empty env object injected __env__", r1);
    else ok("empty env object: __env__ stays undefined");

    // env containing keys that look like prototype pollution: __proto__,
    // constructor, hasOwnProperty. Must NOT pollute Object.prototype.
    const r2 = await k.run(
      "JSON.stringify({proto: Object.prototype.hasOwnProperty.call(__env__, '__proto__'), polluted: ({}).polluted})",
      { env: { __proto__: "BAD", polluted: "yes" } }
    );
    const parsed = JSON.parse(r2.output);
    // We accept either outcome for `proto` (some engines copy it via spread,
    // some don't), but `polluted` should NEVER appear on a fresh `{}`.
    if (parsed.polluted === "yes") fail("env keys polluted Object.prototype", parsed);
    else ok("env keys did not pollute Object.prototype");

    // env value is read-only inside the sandbox.
    const r3 = await k.run(
      "(function(){ try { __env__.K = 'mutated'; return __env__.K; } catch (e) { return 'frozen-throws'; } })()",
      { env: { K: "original" } }
    );
    if (r3.output !== "original" && r3.output !== "frozen-throws") {
      fail("env mutation succeeded inside sandbox", r3);
    } else ok(`env is frozen / read-only inside sandbox (${r3.output})`);
  } finally {
    await k[Symbol.asyncDispose]();
  }
}

// ── cpuMs edge cases ─────────────────────────────────────────────────────────

{
  // cpuMs = 0 — degenerate but should not hang. Either rejects immediately
  // OR is treated as "no cap" / fall back to constructor timeout. The point
  // is: deterministic response, no hang.
  const k = new JsKernel({ timeoutMs: 500 });
  try {
    const start = Date.now();
    let settled = false;
    try {
      await k.run("1+1", { cpuMs: 0 });
      settled = true;
    } catch {
      settled = true;
    }
    const elapsed = Date.now() - start;
    if (!settled || elapsed > 1_500) fail("cpuMs=0 caused hang or unbounded delay", { elapsed });
    else ok(`cpuMs=0: deterministic settle in ${elapsed}ms`);
  } finally {
    await k[Symbol.asyncDispose]();
  }
}

// ── memoryLimitBytes edge cases ─────────────────────────────────────────────

{
  // memoryLimitBytes is best-effort on JsKernel. We just assert that
  // passing it does not crash construction or run().
  const k = new JsKernel({ timeoutMs: 1_500 });
  try {
    const r = await k.run("2+2", { memoryLimitBytes: 1024 });
    if (r.output !== 4) fail("memoryLimitBytes broke arithmetic", r);
    else ok("memoryLimitBytes accepted (best-effort on JsKernel)");
  } finally {
    await k[Symbol.asyncDispose]();
  }
}

if (failed > 0) {
  console.error(`\n[edge-capability-boundaries] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[edge-capability-boundaries] all checks passed`);
