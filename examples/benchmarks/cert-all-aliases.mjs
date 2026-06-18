#!/usr/bin/env node
/**
 * cert-all-aliases.mjs — V3 of the desktop-agent feasibility plan.
 *
 * Walks every entry in MODEL_REGISTRY, downloads via the multi-mirror
 * downloader, computes sha256 on real bytes, then runs the cert pipeline
 * (local-model-cert.mjs's three dimensions) against each. Output:
 *
 *   docs/reports/local-model-cert-2026-06-13/<alias>.md  — per-model report
 *   docs/reports/local-model-cert-2026-06-13/sha256.json — sha256 backfill data
 *
 * The sha256 values are the ones the human will copy back into
 * packages/model-local/src/registry.ts. We deliberately do NOT auto-edit
 * the source — pinning a hash is a security event that deserves a human
 * review (the PR diff is the audit trail).
 *
 * ## Resumability
 *
 * Each model's work is broken into three steps:
 *   1. download        — re-runs cheaply if the file is already cached
 *   2. sha256          — computed against the cached file (always cheap)
 *   3. cert run        — `--limit 6 --kernel quickjs`; can be re-run
 *
 * If the script is interrupted mid-fleet, re-running picks up from the
 * cached files. We write sha256.json *incrementally*, one model at a time,
 * so a crash in alias #3 doesn't lose the hashes of #1 and #2.
 *
 * ## Flags
 *
 *   --aliases a,b,c   Only run these aliases (default: every entry in registry)
 *   --skip-cert       Just do download + sha256 (no LLM inference)
 *   --limit N         Items per cert dimension (default 6 — smoke)
 *   --grammar / --no-grammar
 *   --mirror <kind>   Override download mirror preference
 *   --cacheDir <path> Override model cache dir
 *   --out <dir>       Output directory (default docs/reports/local-model-cert-<date>/)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

async function main() {
  const { values } = parseArgs({
    options: {
      aliases: { type: "string" },
      "skip-cert": { type: "boolean" },
      limit: { type: "string", default: "6" },
      grammar: { type: "boolean" },
      "no-grammar": { type: "boolean" },
      mirror: { type: "string" },
      cacheDir: { type: "string" },
      out: { type: "string" },
    },
  });

  const limit = Number.parseInt(values.limit, 10);
  const noGrammar = values["no-grammar"] === true;
  const today = new Date().toISOString().slice(0, 10);
  const outDir = values.out
    ? resolve(values.out)
    : join(REPO_ROOT, "docs", "reports", `local-model-cert-${today}`);
  await mkdir(outDir, { recursive: true });

  // Resolve @wasmagent/model-local from dist (built via `bun run -F ... build`).
  const localPath = join(REPO_ROOT, "packages/model-local/dist/index.js");
  if (!existsSync(localPath)) {
    console.error(
      `[cert-all] @wasmagent/model-local is not built. Run: bun run -F '@wasmagent/model-local' build`
    );
    process.exit(2);
  }
  const { computeSha256, resolveModel, listRegisteredModels } = await import(localPath);

  let aliases = listRegisteredModels().map((m) => m.alias);
  if (values.aliases) aliases = values.aliases.split(",").map((s) => s.trim()).filter(Boolean);

  console.error(`[cert-all] target aliases: ${aliases.join(", ")}`);
  console.error(`[cert-all] output dir: ${outDir}`);

  const sha256Path = join(outDir, "sha256.json");
  /** @type {Record<string, { alias: string; sha256: string; sizeBytes: number; sourceUsed: { kind: string; url: string }; cacheHit: boolean; computedAt: string; certReport?: string }>} */
  const accumulated = existsSync(sha256Path) ? JSON.parse(readFileSync(sha256Path, "utf8")) : {};

  for (const alias of aliases) {
    if (accumulated[alias]?.sha256 && accumulated[alias].sha256.length === 64 && !values["force"]) {
      console.error(`[cert-all] ${alias} — sha256 already pinned in ${sha256Path}, skipping download`);
    } else {
      console.error(`[cert-all] ${alias} — downloading (mirror=${values.mirror ?? "<default>"})`);
      try {
        const dl = await resolveModel(alias, {
          ...(values.cacheDir ? { cacheDir: values.cacheDir } : {}),
          ...(values.mirror ? { mirror: values.mirror } : {}),
          onProgress: (sent, total) => {
            if (total > 0 && sent % (16 * 1024 * 1024) < 65536) {
              const pct = ((sent / total) * 100).toFixed(1);
              process.stderr.write(`\r[cert-all] ${alias}: ${pct}% (${(sent / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB)`);
            }
          },
        });
        process.stderr.write("\n");
        const sha = await computeSha256(dl.path);
        const st = await stat(dl.path);
        accumulated[alias] = {
          alias,
          sha256: sha,
          sizeBytes: st.size,
          sourceUsed: { kind: dl.sourceUsed.kind, url: dl.sourceUsed.url },
          cacheHit: dl.cacheHit,
          computedAt: new Date().toISOString(),
        };
        writeFileSync(sha256Path, JSON.stringify(accumulated, null, 2), "utf8");
        console.error(`[cert-all] ${alias} sha256=${sha} (${(st.size / 1024 / 1024).toFixed(1)} MB) → ${sha256Path}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        accumulated[alias] = {
          alias,
          sha256: "",
          sizeBytes: 0,
          sourceUsed: { kind: "error", url: msg },
          cacheHit: false,
          computedAt: new Date().toISOString(),
        };
        writeFileSync(sha256Path, JSON.stringify(accumulated, null, 2), "utf8");
        console.error(`[cert-all] ${alias} download failed: ${msg}`);
        continue;
      }
    }

    if (values["skip-cert"]) continue;
    const reportPath = join(outDir, `${alias}.md`);
    const args = [
      join(REPO_ROOT, "examples/benchmarks/local-model-cert.mjs"),
      "--model",
      alias,
      "--limit",
      String(limit),
      "--kernel",
      "quickjs",
      "--out",
      reportPath,
    ];
    if (noGrammar) args.push("--no-grammar");
    if (values.mirror) args.push("--mirror", values.mirror);
    console.error(`[cert-all] ${alias} — cert run → ${reportPath}`);
    const code = await runChild(process.execPath, args);
    accumulated[alias].certReport = reportPath;
    accumulated[alias].certExit = code;
    writeFileSync(sha256Path, JSON.stringify(accumulated, null, 2), "utf8");
  }

  // Summary at end
  console.error("\n[cert-all] Final summary:");
  for (const a of aliases) {
    const r = accumulated[a];
    if (!r) {
      console.error(`  ${a}: <missing>`);
      continue;
    }
    const ok = r.sha256.length === 64;
    console.error(`  ${a}: ${ok ? "✅" : "❌"} sha256=${r.sha256.slice(0, 16) || "<failed>"}…  ${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  }
  console.error(`\n[cert-all] sha256.json → ${sha256Path}`);
  console.error(`[cert-all] copy these into packages/model-local/src/registry.ts manually after review.`);
}

function runChild(cmd, args) {
  return new Promise((resolveFn) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code) => resolveFn(code ?? 0));
  });
}

main().catch((e) => {
  console.error("[cert-all] fatal:", e);
  process.exit(1);
});
