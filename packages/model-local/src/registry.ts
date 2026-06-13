/**
 * Official local-model registry — the "name → mirrors + sha256 + license" table.
 *
 * Adding a model here means committing to:
 *   1. Multiple download sources (HF + at least one PRC-friendly mirror).
 *   2. The sha256 of the canonical artifact (anchored to the HF original).
 *   3. The license — surfaced to users so re-distribution rules are clear.
 *
 * A model only enters {@link RECOMMENDED_MODELS} after passing the cert pipeline
 * (see `examples/benchmarks/local-model-cert.mjs`). The fields here describe the
 * artifact; benchmarked-quality scores live next to the cert script as JSON.
 *
 * 2026-06-13 audit (V3 of the desktop-agent feasibility plan): four of the
 * five originally-listed alias URLs returned 404. The cert pipeline run on
 * real hardware is what surfaced the issue — README badge accuracy was
 * measuring placeholders, not artifacts. URLs are now repointed to the
 * actual canonical repos for each model family, sha256 are real values
 * computed from the downloaded files, and `qwen3.5-0.8b` was dropped (no
 * such checkpoint published on HF as of 2026-06-13). `qwen2.5-1.5b` was
 * added — it's the Stage-0 ≤2GB winner from the parallel evomerge work
 * (Q8_0 GSM8K 70.5%) and the model the V2 ablation needs to actually run.
 *
 * The audit log: `docs/reports/local-model-cert-2026-06-13/sha256.json`.
 */

export type SourceKind = "huggingface" | "hf-mirror" | "modelscope" | "url";

export interface ModelSource {
  kind: SourceKind;
  /** Full URL to the GGUF artifact. For mirrors, must end with the same filename as HF. */
  url: string;
}

export interface RegisteredModel {
  /** Canonical alias used by `new LocalModel({ model: "..." })`. */
  alias: string;
  /** Human-friendly description shown in `agentkit model list`. */
  description: string;
  /** Ordered list of download sources — index 0 is the canonical (sha256 anchor). */
  sources: ModelSource[];
  /**
   * Expected sha256 of the GGUF file. Empty string means "not yet pinned" —
   * downloads succeed with a warning. Update once the cert pipeline runs.
   */
  sha256: string;
  /** Approximate file size in bytes (used for disk-space pre-check & progress). */
  sizeBytes: number;
  /** SPDX-style license identifier; some require attribution on redistribution. */
  license: string;
  /**
   * Minimum free RAM (in GB) suggested for loading at the default context size.
   * Used by the CLI to warn before downloading a model the host can't run.
   */
  minFreeMemGB: number;
  /** Default context window in tokens (model-trained max). */
  contextWindow: number;
  /** Whether this entry is currently part of the official recommended list. */
  recommended: boolean;
  /** Free-form note shown in CLI / README — e.g. "中文最优". */
  note?: string;
}

/**
 * Registry — canonical IDs registered as candidates for the official list.
 *
 * Inclusion criteria:
 *   - GGUF available on HuggingFace (anchor source).
 *   - <1.5GB at recommended quant (Q4_K_M typical).
 *   - Permissive enough license (Apache-2.0, MIT, Gemma, Llama Community).
 *
 * Models not yet pinned (`sha256: ""`, `recommended: false`) are listed here
 * so users can `--model` them; promotion to recommended happens via the cert
 * pipeline in L4.
 */
export const MODEL_REGISTRY: Record<string, RegisteredModel> = {
  "qwen2.5-0.5b": {
    alias: "qwen2.5-0.5b",
    description: "Qwen 2.5 0.5B Instruct — smallest viable model; 100% tool-call form/picked/semantic on cert (379 MB q4_0)",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf",
      },
      {
        kind: "modelscope",
        url: "https://modelscope.cn/api/v1/models/qwen/Qwen2.5-0.5B-Instruct-GGUF/repo?Revision=master&FilePath=qwen2.5-0.5b-instruct-q4_0.gguf",
      },
    ],
    sha256: "7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed",
    sizeBytes: 428_730_208,
    license: "Apache-2.0",
    minFreeMemGB: 1,
    contextWindow: 32_768,
    recommended: false,
    note: "真机验证 2026-06-12: 工具调用 3/3 form/picked/semantic, 双语 4/4, CodeAgent 不胜任(0.5B 太小)。最小可用模型,首-token 70-310ms (Apple Silicon Metal)。sha256 pinned 2026-06-13 (V3 cert run, hf-mirror).",
  },
  "qwen2.5-1.5b": {
    alias: "qwen2.5-1.5b",
    description: "Qwen 2.5 1.5B Instruct (Q4_K_M) — Stage-0 ≤2GB winner from evomerge eval (GSM8K 70.5% Q8_0). Sweet spot for tool-calling on consumer laptops.",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      },
      {
        kind: "modelscope",
        url: "https://modelscope.cn/api/v1/models/qwen/Qwen2.5-1.5B-Instruct-GGUF/repo?Revision=master&FilePath=qwen2.5-1.5b-instruct-q4_k_m.gguf",
      },
    ],
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    sizeBytes: 1_117_320_736,
    license: "Apache-2.0",
    minFreeMemGB: 2,
    contextWindow: 32_768,
    recommended: true,
    note: "1.5B 是 BFCL/TinyLLM 同时确认的边缘工具调用甜区。q4_k_m 平衡精度与体积。sha256 pinned 2026-06-13 (V3, hf-mirror).",
  },
  "qwen3-0.6b": {
    alias: "qwen3-0.6b",
    description: "Qwen 3 0.6B (Q8_0) — official Qwen3 GGUF only ships Q8_0 quant for 0.6B (Q4_K_M not published). Best for instruction-following at <1GB.",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf",
      },
      {
        kind: "modelscope",
        url: "https://modelscope.cn/api/v1/models/qwen/Qwen3-0.6B-GGUF/repo?Revision=master&FilePath=Qwen3-0.6B-Q8_0.gguf",
      },
    ],
    sha256: "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031",
    sizeBytes: 639_446_688,
    license: "Apache-2.0",
    minFreeMemGB: 2,
    contextWindow: 32_768,
    recommended: false,
    note: "TinyLLM 2025-11 baseline: 0.6B 多轮 1.38% — 用于 V2 消融下端。sha256 pinned 2026-06-13 (V3, hf-mirror).",
  },
  "gemma-3-1b": {
    alias: "gemma-3-1b",
    description: "Gemma 3 1B Instruct (Q4_K_M) — English tasks, Google. Mirror via ggml-org repo (the original google/* GGUF repo is QAT-only with broken canonical URL).",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf",
      },
    ],
    sha256: "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135",
    sizeBytes: 806_058_240,
    license: "Gemma-Terms-of-Use",
    minFreeMemGB: 2,
    contextWindow: 32_768,
    recommended: false,
    note: "Gemma 许可对再分发有附加条款;框架不打包模型,首次使用按需下载。sha256 pinned 2026-06-13 (V3, hf-mirror via ggml-org).",
  },
  "llama-3.2-1b": {
    alias: "llama-3.2-1b",
    description: "Llama 3.2 1B Instruct (Q4_K_M) — English/code, Meta. Mirror via lmstudio-community (the meta-llama/* GGUF repo is gated and the canonical URL 404s for unauthenticated downloads).",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/lmstudio-community/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/lmstudio-community/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
      },
    ],
    sha256: "f7ede42862ceca07ad1c88a97b67520019c4ac7e5ced250d2e696fa62ab189af",
    sizeBytes: 807_690_688,
    license: "Llama-3.2-Community-License",
    minFreeMemGB: 2,
    contextWindow: 131_072,
    recommended: false,
    note: "Llama 许可对再分发有附加条款。sha256 pinned 2026-06-13 (V3, hf-mirror via lmstudio-community).",
  },
};

/**
 * Look up a registered model by alias. Throws when not found — callers
 * use {@link listRegisteredModels} for safe enumeration.
 */
export function getRegisteredModel(alias: string): RegisteredModel {
  const m = MODEL_REGISTRY[alias];
  if (!m) {
    const known = Object.keys(MODEL_REGISTRY).join(", ");
    throw new Error(`Unknown model alias: "${alias}". Known: ${known}`);
  }
  return m;
}

export function listRegisteredModels(): RegisteredModel[] {
  return Object.values(MODEL_REGISTRY);
}

/**
 * Pick sources by mirror preference. The chosen source is moved to index 0;
 * any remaining sources keep their relative order so retries cycle through
 * the registry tail.
 *
 * `mirror` semantics:
 *   - One of the {@link SourceKind} values → the first matching source wins.
 *   - A custom URL prefix → a synthetic `kind: "url"` source is prepended
 *     with the suffix of the canonical HF URL re-attached. Useful for
 *     team-internal CDNs that mirror HF paths verbatim.
 */
export function orderSources(model: RegisteredModel, mirror?: string): ModelSource[] {
  if (!mirror) return [...model.sources];

  // Match by kind first.
  const byKind = model.sources.find((s) => s.kind === mirror);
  if (byKind) {
    return [byKind, ...model.sources.filter((s) => s !== byKind)];
  }

  // Otherwise treat as a URL prefix and synthesise a custom source.
  if (/^https?:\/\//.test(mirror)) {
    const hf = model.sources.find((s) => s.kind === "huggingface");
    if (hf) {
      const filename = hf.url.split("/").pop() ?? "";
      const synthetic: ModelSource = {
        kind: "url",
        url: mirror.replace(/\/+$/, "") + "/" + filename,
      };
      return [synthetic, ...model.sources];
    }
  }

  // Unknown mirror token — fall back to declared order.
  return [...model.sources];
}
