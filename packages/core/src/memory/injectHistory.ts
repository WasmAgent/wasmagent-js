/**
 * injectHistoryIntoAssembler — inject prior conversation turns into a
 * `MessageAssembler` so that the assembler begins from a previously
 * established conversation state.
 *
 * Express / Node.js HTTP handlers that use `ToolCallingAgent` in a
 * stateless request/response loop need to replay prior conversation turns
 * before each request. Rather than each caller re-implementing the
 * three-shape mapping logic (plain text, single tool use, parallel tool
 * calls), this utility centralises it.
 *
 * Handles three message shapes:
 *   1. Pure text turns (`role: "assistant", content: string`)
 *   2. Single tool use — assistant message with a `tool_use` block plus a
 *      user message with a `tool_result` block
 *   3. Parallel tool calls — multiple `tool_use` blocks in one assistant
 *      message and multiple `tool_result` blocks in the matching user message
 *
 * All shapes are added via `MessageAssembler.addRawMessage` so the
 * assembler emits them verbatim on the next `build()` call.
 *
 * @example
 * ```ts
 * import { injectHistoryIntoAssembler } from "@wasmagent/core";
 *
 * // Before each HTTP request, replay prior turns
 * await injectHistoryIntoAssembler(agent.assembler, previousMessages);
 * ```
 */

import type { ModelMessage } from "../models/types.js";
import type { MessageAssembler } from "./MessageAssembler.js";

/**
 * Inject an array of prior `ModelMessage` turns into `assembler` so that
 * the assembler's next `build()` output includes the full conversation
 * history.
 *
 * All three message shapes used in tool-calling conversations are handled:
 *   - Pure text assistant turns
 *   - Single `tool_use` / `tool_result` pairs
 *   - Parallel `tool_use` blocks (multiple calls in one assistant message)
 *     with matching `tool_result` blocks in the following user message
 *
 * @param assembler - The `MessageAssembler` instance to inject into.
 * @param messages  - Prior conversation turns in `ModelMessage[]` format.
 */
export function injectHistoryIntoAssembler(
  assembler: MessageAssembler,
  messages: ModelMessage[]
): void {
  for (const msg of messages) {
    assembler.addRawMessage(msg);
  }
}
