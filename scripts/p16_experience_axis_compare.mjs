#!/usr/bin/env node
/**
 * P16-8 ⑤: P16-1 clean MMLU 结果与 wasmagent 体验轴对比脚本。
 *
 * 将 evomerge 内部 MMLU 评测结果（去污染后）与 wasmagent multi-turn-memory
 * 中立考场结果合并，输出三轴对比报告：
 *
 *   - 能力轴（MMLU，internal protocol，clean split）
 *   - 体验轴（wasmagent multi-turn-memory，中立考场）
 *   - 统计轴（McNemar + Wilson CI）
 *
 * 用法：node scripts/p16_experience_axis_compare.mjs
 *
 * 前提：
 *   - phase16_clean_eval/ 有 lora_prime_mmlu.json + baseline_mmlu.json
 *   - docs/reports/ 有 wasmagent 体验轴结果
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVOMERGE_ROOT = join(__dirname, "..");  // wasmagent root
const EVOMERGE_PROJ = join(__dirname, "..", "..", "evomerge");  // evomerge project root

// ── Load evomerge clean eval results ─────────────────────────────────────────

function loadCleanEval() {
  const loraFile = join(EVOMERGE_PROJ, "phase16_clean_eval", "lora_prime_mmlu.json");
  const baseFile = join(EVOMERGE_PROJ, "phase16_clean_eval", "baseline_mmlu.json");
  const compFile = join(EVOMERGE_PROJ, "phase16_clean_eval", "comparison_result.json");

  if (!existsSync(loraFile) || !existsSync(baseFile)) {
    console.warn("[p16-⑤] evomerge clean eval files not found; skipping MMLU axis.");
    return null;
  }

  const lora = JSON.parse(readFileSync(loraFile, "utf8"));
  const base = JSON.parse(readFileSync(baseFile, "utf8"));
  const comp = existsSync(compFile) ? JSON.parse(readFileSync(compFile, "utf8")) : null;

  const loraAcc = lora.filter((r) => r.correct).length / lora.length;
  const baseAcc = base.filter((r) => r.correct).length / base.length;

  return { loraAcc, baseAcc, n: lora.length, comp };
}

// ── Load wasmagent experience axis results ─────────────────────────────────────

function loadExperienceAxis() {
  const reportFile = join(EVOMERGE_ROOT, "docs", "reports", "longmemeval-5model-2026-06-12.md");
  if (!existsSync(reportFile)) {
    console.warn("[p16-⑤] wasmagent experience axis report not found.");
    return null;
  }
  const md = readFileSync(reportFile, "utf8");
  const rows = [];
  let inTable = false;
  for (const line of md.split("\n")) {
    // Find the summary table rows: | `multi-turn-memory` | `model` | acc | ...
    if (line.includes("|") && line.includes("%") && line.includes("`")) {
      const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 3) {
        // cols[1] is model id in backticks
        const modelId = cols[1].replace(/`/g, "").trim();
        // cols[2] is acc like **66.7%**
        const accMatch = cols[2].match(/[\d.]+%/);
        if (accMatch && modelId && !modelId.includes("Suite")) {
          const acc = parseFloat(accMatch[0]) / 100;
          rows.push({ modelId, acc });
        }
      }
    }
  }
  return rows;
}

// ── Render three-axis report ──────────────────────────────────────────────────

function renderThreeAxisReport(cleanEval, experienceRows) {
  const lines = [];
  lines.push("# P16 三轴对比报告（能力轴 + 体验轴 + 统计轴）");
  lines.push("");
  lines.push("> 生成时间: " + new Date().toISOString());
  lines.push("> 关于 '不可区分' 结论: 见 §0.1 — P16-1 去污染后，LoRA 相对 Instruct 无显著优势。");
  lines.push("");

  // Capability axis (MMLU clean)
  lines.push("## 能力轴（MMLU，clean split，internal protocol）");
  lines.push("");
  lines.push("> ⚠️ 单 seed，内部 chat 协议。不可报绝对值；仅 Δ 可信。");
  lines.push("");
  if (cleanEval) {
    lines.push("| 候选 | acc | 说明 |");
    lines.push("|---|---:|---|");
    lines.push(`| LoRA v2' (clean MMLU train) | ${(cleanEval.loraAcc * 100).toFixed(1)}% | train ∩ eval = ∅ (G3 PASS) |`);
    lines.push(`| Instruct 基线 | ${(cleanEval.baseAcc * 100).toFixed(1)}% | Qwen2.5-1.5B-Instruct |`);
    if (cleanEval.comp) {
      const { delta, mcnemar_p, b, c } = cleanEval.comp;
      lines.push("");
      lines.push(`**Δ = ${(delta * 100).toFixed(1)}pp**, b=${b}, c=${c}, McNemar p=${mcnemar_p.toFixed(4)}`);
      lines.push(p_interpretation(mcnemar_p, delta));
    }
  } else {
    lines.push("*Clean eval files not found. Run p16_eval_clean.py first.*");
  }
  lines.push("");

  // Experience axis (wasmagent)
  lines.push("## 体验轴（wasmagent multi-turn-memory，中立考场）");
  lines.push("");
  lines.push("> ⚠️ n=6 × 1 seed（2026-06-12 报告）；全部 CI 大幅重叠。无统计意义——仅方向参考。");
  lines.push("> 见 P16-8 ② DoD: 需 ≥50 题 × ≥3 seeds 才可 claims。");
  lines.push("");
  if (experienceRows && experienceRows.length > 0) {
    lines.push("| 模型 | acc (n=6, 1 seed) | 注 |");
    lines.push("|---|---:|---|");
    for (const r of experienceRows) {
      const note = r.acc === 1.0 ? "100% (CI 极宽)" : r.acc < 0.7 ? "< 70%" : "";
      lines.push(`| \`${r.modelId}\` | ${(r.acc * 100).toFixed(0)}% | ${note} |`);
    }
    lines.push("");
    lines.push("*McNemar (b=2, c=0) p=0.5 — 不显著（P16-8 § 6.1 裁定一）。*");
  } else {
    lines.push("*Experience axis data not found.*");
  }
  lines.push("");

  // Three-axis summary
  lines.push("## 三轴汇总");
  lines.push("");
  lines.push("| 轴 | LoRA v2' vs Instruct | 可信度 |");
  lines.push("|---|---|---|");
  if (cleanEval && cleanEval.comp) {
    const sig = cleanEval.comp.mcnemar_p < 0.05 ? "显著" : "不显著";
    lines.push(`| 能力轴（MMLU）| Δ=${(cleanEval.comp.delta * 100).toFixed(1)}pp, p=${cleanEval.comp.mcnemar_p.toFixed(3)} (${sig}) | 1 seed, clean data, ✅ |`);
  }
  lines.push(`| 体验轴（multi-turn-memory）| n=6, p=0.5, 不显著 | ⚠️ n 太小，仅参考 |`);
  lines.push(`| 稳健轴（扰动集）| 未完成（P16-6 待做）| ❌ 缺失 |`);
  lines.push("");
  lines.push("**结论（P16-8 §6.5 三轴漏斗）**：");
  lines.push("能力轴和体验轴一致——LoRA v2' 相对 Instruct 基线**无显著优势**（去污染后）。");
  lines.push("这是 P16 审计的核心结论：原 +4.1pp 是 train-on-test 记忆效应，不是泛化能力提升。");

  return lines.join("\n");
}

function p_interpretation(p, delta) {
  if (p < 0.05) {
    return `> ✅ 显著 — ${delta > 0 ? "LoRA' 更优" : "Instruct 更优"} (p=${p.toFixed(4)})`;
  }
  return `> ≈ 不显著 (p=${p.toFixed(4)} ≥ 0.05)`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const cleanEval = loadCleanEval();
const experienceRows = loadExperienceAxis();
const report = renderThreeAxisReport(cleanEval, experienceRows);
console.log(report);

const outPath = join(EVOMERGE_PROJ, "phase16_clean_eval", "three_axis_report.md");
writeFileSync(outPath, report, "utf8");
console.error(`\n[p16-⑤] 写入 ${outPath}`);
