/**
 * @wasmagent/core/prompts — composable system-prompt fragments.
 *
 * Provides building blocks for system prompts (reasoning preambles, sandbox
 * descriptions, output contracts, error-recovery rules, card-block
 * conventions), plus a {@link composePrompt} composer.
 *
 * Previously published as the standalone @wasmagent/agent-prompts package;
 * now available as a subpath export of @wasmagent/core.
 */

export type { ComposePromptInput } from "./composePrompt.js";
export { composePrompt } from "./composePrompt.js";
export {
  DIAGRAMS_CODE_JS,
  DIAGRAMS_CODE_PYTHON,
  DIAGRAMS_GENERIC,
} from "./diagrams.js";
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
  TOOL_SYNTHESIS_FRAGMENT,
} from "./fragments.js";
