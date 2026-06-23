/**
 * @wasmagent/model-local — public types.
 *
 * The Model interface itself comes from @wasmagent/core; this file only
 * declares option shapes specific to the embedded local-LLM provider.
 */

/**
 * Three equivalent ways to load a GGUF model.
 *
 * - `path`  — absolute or relative path to a local .gguf file (user-owned model
 *             of any size, including <1GB self-trained models).
 * - `model` — alias from the official registry (see {@link MODEL_REGISTRY}).
 *             Triggers a multi-mirror download with sha256 verification.
 * - `url`   — direct URL to a .gguf file (any host). The expected sha256 must
 *             be supplied separately via `expectedSha256` if integrity matters.
 */
export type LocalModelSource =
  | { path: string }
  | { model: string }
  | { url: string; expectedSha256?: string };

/**
 * Mirror selection policy for {@link MODEL_REGISTRY} aliases.
 *
 * Resolution precedence (high → low):
 *   1. Explicit `source` option (this field).
 *   2. Environment variable `WASMAGENT_MODEL_MIRROR`.
 *   3. Registry-declared order (typically HuggingFace first).
 *
 * Either a registered preset name or a URL prefix to use as a custom base.
 */
export type MirrorPreset = "huggingface" | "hf-mirror" | "modelscope" | (string & {});

export interface LocalModelOptions {
  /** Source of the model file — exactly one of path/model/url. */
  source: LocalModelSource;

  /** Override mirror preference for registry-aliased models. */
  mirror?: MirrorPreset;

  /** Cache directory. Default: `~/.wasmagent/models` (or `$WASMAGENT_MODEL_DIR`). */
  cacheDir?: string;

  /**
   * Sampling defaults — applied when GenerateOptions does not override them.
   * node-llama-cpp accepts these on createCompletion(); we forward verbatim.
   */
  temperature?: number;
  topP?: number;
  topK?: number;

  /**
   * Hardware hints forwarded to node-llama-cpp's getLlama()/loadModel().
   * `gpuLayers: "max" | number` — see node-llama-cpp's auto/Metal/CUDA/Vulkan
   * detection. Omit to use the engine's default heuristic.
   */
  gpuLayers?: number | "max" | "auto";
  threads?: number;
  contextSize?: number;

  /**
   * When true (default), enables grammar-constrained JSON output for tool calls.
   * Set to false to fall back to free-form generation (useful for diffing).
   */
  enableGrammar?: boolean;

  /**
   * Override providerId. Default: `"local-llama"` (or the registry alias).
   * Useful when running multiple LocalModel instances for routing/telemetry.
   */
  providerId?: string;

  /**
   * Optional progress callback invoked during downloads. Receives
   * (transferredBytes, totalBytes) — totalBytes may be 0 if unknown.
   */
  onDownloadProgress?: (transferred: number, total: number) => void;

  /**
   * Skip integrity verification of `path` source. Default: true (no checksum
   * is enforced for user-supplied files; alias and url-with-sha256 sources
   * are always verified).
   */
  skipIntegrityCheckForLocalPath?: boolean;
}

/** Errors thrown by this package — sub-classed for callers that want to introspect. */
export class LocalModelError extends Error {
  readonly localModelCause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LocalModelError";
    this.localModelCause = cause;
  }
}

export class LocalModelDependencyError extends LocalModelError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LocalModelDependencyError";
  }
}

export class LocalModelDownloadError extends LocalModelError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LocalModelDownloadError";
  }
}

export class LocalModelChecksumError extends LocalModelError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LocalModelChecksumError";
  }
}
