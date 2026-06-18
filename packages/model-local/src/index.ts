/**
 * @wasmagent/model-local — embedded llama.cpp adapter for agentkit-js.
 *
 * Quick start:
 *
 *   ```ts
 *   import { LocalModel } from "@wasmagent/model-local";
 *   import { CodeAgent } from "@wasmagent/core";
 *
 *   const model = new LocalModel({ source: { model: "qwen2.5-1.5b" } });
 *   const agent = new CodeAgent({ model, tools: [] });
 *   for await (const ev of agent.run("compute 2+2")) console.log(ev);
 *   ```
 *
 * See README for mirror selection (HuggingFace / hf-mirror / ModelScope),
 * grammar-constrained tool calling, and the `localFirst` routing preset.
 */

export {
  computeSha256,
  type DownloadOptions,
  defaultCacheDir,
  downloadGGUF,
  downloadUrl,
  effectiveMirror,
  filenameForSource,
  resolveModel,
} from "./downloader.js";
export {
  buildResponseFormatSchema,
  buildToolCallSchema,
  buildToolPromptAddendum,
  type ExtractedTool,
  extractTools,
  type ParsedToolCallOutput,
  parseToolCallOutput,
} from "./grammar.js";
export { __setLlamaModuleForTests, LocalModel, renderMessagesAsPrompt } from "./LocalModel.js";
export { devLocalOr, localFirst, offlineOnly } from "./presets.js";
export {
  getRegisteredModel,
  listRegisteredModels,
  MODEL_REGISTRY,
  type ModelSource,
  orderSources,
  type RegisteredModel,
  type SourceKind,
} from "./registry.js";
export {
  LocalModelChecksumError,
  LocalModelDependencyError,
  LocalModelDownloadError,
  LocalModelError,
  type LocalModelOptions,
  type LocalModelSource,
  type MirrorPreset,
} from "./types.js";
