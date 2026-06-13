/**
 * @agentkit-js/model-local — embedded llama.cpp adapter for agentkit-js.
 *
 * Quick start:
 *
 *   ```ts
 *   import { LocalModel } from "@agentkit-js/model-local";
 *   import { CodeAgent } from "@agentkit-js/core";
 *
 *   const model = new LocalModel({ source: { model: "qwen2.5-1.5b" } });
 *   const agent = new CodeAgent({ model, tools: [] });
 *   for await (const ev of agent.run("compute 2+2")) console.log(ev);
 *   ```
 *
 * See README for mirror selection (HuggingFace / hf-mirror / ModelScope),
 * grammar-constrained tool calling, and the `localFirst` routing preset.
 */

export { LocalModel, renderMessagesAsPrompt, __setLlamaModuleForTests } from "./LocalModel.js";
export {
  type LocalModelOptions,
  type LocalModelSource,
  type MirrorPreset,
  LocalModelError,
  LocalModelDependencyError,
  LocalModelDownloadError,
  LocalModelChecksumError,
} from "./types.js";
export {
  type RegisteredModel,
  type ModelSource,
  type SourceKind,
  MODEL_REGISTRY,
  getRegisteredModel,
  listRegisteredModels,
  orderSources,
} from "./registry.js";
export {
  type DownloadOptions,
  computeSha256,
  defaultCacheDir,
  effectiveMirror,
  filenameForSource,
  resolveModel,
  downloadGGUF,
  downloadUrl,
} from "./downloader.js";
export {
  type ExtractedTool,
  type ParsedToolCallOutput,
  buildToolCallSchema,
  buildToolPromptAddendum,
  buildResponseFormatSchema,
  extractTools,
  parseToolCallOutput,
} from "./grammar.js";
export { localFirst, offlineOnly, devLocalOr } from "./presets.js";
