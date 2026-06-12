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
 * ⚠️ The sha256 values below are PLACEHOLDERS until the cert pipeline runs on
 * real hardware (see L4 in the implementation plan). Until then, callers
 * supplying `model:` aliases will get a clear "checksum unverified — pin
 * sha256 yourself or download manually" warning rather than a hash failure.
 * The runtime treats `sha256: ""` as "skip verification with warning".
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
  "qwen3.5-0.8b": {
    alias: "qwen3.5-0.8b",
    description: "Qwen 3.5 0.8B — 262K context, 200+ languages, best for Chinese tasks",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/Qwen/Qwen3.5-0.8B-Instruct-GGUF/resolve/main/qwen3.5-0.8b-instruct-q4_k_m.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/Qwen/Qwen3.5-0.8B-Instruct-GGUF/resolve/main/qwen3.5-0.8b-instruct-q4_k_m.gguf",
      },
      {
        kind: "modelscope",
        url: "https://modelscope.cn/api/v1/models/qwen/Qwen3.5-0.8B-Instruct-GGUF/repo?Revision=master&FilePath=qwen3.5-0.8b-instruct-q4_k_m.gguf",
      },
    ],
    sha256: "",
    sizeBytes: 530_000_000,
    license: "Apache-2.0",
    minFreeMemGB: 2,
    contextWindow: 262_144,
    recommended: false,
    note: "中文最优;思考模式在小尺寸上需要采样调参,首轮 cert 跑分后会标注稳定区间",
  },
  "qwen3-0.6b": {
    alias: "qwen3-0.6b",
    description: "Qwen 3 0.6B Instruct — Ollama 生态默认小模型,成熟稳定",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/Qwen/Qwen3-0.6B-Instruct-GGUF/resolve/main/qwen3-0.6b-instruct-q4_k_m.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/Qwen/Qwen3-0.6B-Instruct-GGUF/resolve/main/qwen3-0.6b-instruct-q4_k_m.gguf",
      },
      {
        kind: "modelscope",
        url: "https://modelscope.cn/api/v1/models/qwen/Qwen3-0.6B-Instruct-GGUF/repo?Revision=master&FilePath=qwen3-0.6b-instruct-q4_k_m.gguf",
      },
    ],
    sha256: "",
    sizeBytes: 400_000_000,
    license: "Apache-2.0",
    minFreeMemGB: 2,
    contextWindow: 32_768,
    recommended: false,
  },
  "gemma-3-1b": {
    alias: "gemma-3-1b",
    description: "Gemma 3 1B Instruct (Q4_K_M) — English tasks, Google",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/google/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-q4_k_m.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/google/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-q4_k_m.gguf",
      },
    ],
    sha256: "",
    sizeBytes: 720_000_000,
    license: "Gemma-Terms-of-Use",
    minFreeMemGB: 2,
    contextWindow: 32_768,
    recommended: false,
    note: "Gemma 许可对再分发有附加条款;框架不打包模型,首次使用按需下载",
  },
  "llama-3.2-1b": {
    alias: "llama-3.2-1b",
    description: "Llama 3.2 1B Instruct (Q4_K_M) — English/code, Meta",
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
      },
      {
        kind: "hf-mirror",
        url: "https://hf-mirror.com/meta-llama/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
      },
    ],
    sha256: "",
    sizeBytes: 800_000_000,
    license: "Llama-3.2-Community-License",
    minFreeMemGB: 2,
    contextWindow: 131_072,
    recommended: false,
    note: "Llama 许可对再分发有附加条款",
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
