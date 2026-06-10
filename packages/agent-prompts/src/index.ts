/**
 * @agentkit-js/agent-prompts — composable system-prompt fragments.
 *
 * agentkit-js is a generic agent runtime. This package provides
 * **building blocks** for system prompts (reasoning preambles, sandbox
 * descriptions, output contracts, error-recovery rules, card-block
 * conventions), plus a {@link composePrompt} composer.
 *
 * It does NOT ship full opinionated prompts for any particular product
 * (e.g. coding-assistant personas, framework-specific file rules). Build
 * those in your own product code by composing these fragments with your
 * own product-specific instructions.
 *
 * @example
 *   import {
 *     composePrompt,
 *     REASONING_FIRST,
 *     SANDBOX_QUICKJS,
 *     OUTPUT_CONTRACT_FINAL_ANSWER,
 *     CODE_QUALITY_GENERIC,
 *     DIAGRAMS_CODE_JS,
 *     ERROR_RECOVERY,
 *   } from "@agentkit-js/agent-prompts";
 *
 *   const prompt = composePrompt({
 *     persona: "You are an expert JavaScript coding assistant.",
 *     fragments: [
 *       REASONING_FIRST,
 *       SANDBOX_QUICKJS,
 *       OUTPUT_CONTRACT_FINAL_ANSWER,
 *       CODE_QUALITY_GENERIC,
 *       DIAGRAMS_CODE_JS,
 *       ERROR_RECOVERY,
 *     ],
 *   });
 */

export type { ComposePromptInput } from "./composePrompt.js";
// Composer
export { composePrompt } from "./composePrompt.js";
// Card-block / diagram conventions
export {
  DIAGRAMS_CODE_JS,
  DIAGRAMS_CODE_PYTHON,
  DIAGRAMS_GENERIC,
} from "./diagrams.js";
// Reasoning preambles
// Output contracts
// Code quality rules
// Error recovery
// File operation rules
// Sandbox descriptions
export {
  CODE_QUALITY_GENERIC,
  CODE_QUALITY_TYPESCRIPT,
  ERROR_RECOVERY,
  FILE_OPS_ATOMIC,
  OUTPUT_CONTRACT_FINAL_ANSWER,
  OUTPUT_CONTRACT_STDOUT,
  REASONING_FIRST,
  SANDBOX_NODE,
  SANDBOX_PYODIDE,
  SANDBOX_QUICKJS,
  STRUCTURED_PLAN,
} from "./fragments.js";
