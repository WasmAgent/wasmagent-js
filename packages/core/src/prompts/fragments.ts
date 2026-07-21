/**
 * Reusable prompt fragments — atomic building blocks an agent author can
 * combine via {@link composePrompt} into a full system prompt.
 *
 * Fragments are intentionally product-agnostic. They encode patterns the
 * field has converged on (reasoning-first, output contracts, error
 * recovery) without prescribing a particular agent persona, sandbox
 * convention, or tool surface.
 *
 * To embed product-specific instructions (custom planning tags, framework
 * file conventions, persona declarations), compose these fragments with
 * your own text via {@link composePrompt} in your product code.
 */

// ── Reasoning preambles ──────────────────────────────────────────────────────

/**
 * "Think before you act" preamble. Reduces wrong-direction runs by
 * forcing the model to state an approach before producing output.
 */
export const REASONING_FIRST = `## Approach (Reasoning-First)
Before producing output, briefly state:
- What the task requires
- Your approach / algorithm
- The expected output shape

Then proceed.`;

/**
 * Stronger planning preamble — forces a structured plan with named
 * sections. Useful for code-generation tasks that touch multiple files.
 */
export const STRUCTURED_PLAN = `## Phase 1: Plan
Before writing any code, output a plan with these sections:
- **Goal:** the user's intent restated
- **Inputs:** what data / files / context you need
- **Outputs:** what you will produce
- **Steps:** ordered list of operations

## Phase 2: Execute
Carry out the plan, deviating only when a step turns out infeasible.`;

// ── Output contracts ─────────────────────────────────────────────────────────

/**
 * Output contract for code-executing agents that need to signal a final
 * value to the kernel. Used by CodeAgent + Pyodide / QuickJS kernels.
 */
export const OUTPUT_CONTRACT_FINAL_ANSWER = `## Output Contract
- Set \`__finalAnswer__ = <value>\` with the final result
- For data/computations: \`__finalAnswer__\` = the computed value (number, array, object, string)
- For HTML/CSS/JS source: build as a template literal string, set \`__finalAnswer__\` = htmlString
- Aliases: \`__final_answer__\` = ... also works`;

/**
 * Output contract for stdout-capturing kernels (Node, shell). The last
 * non-empty line of stdout is treated as the answer.
 */
export const OUTPUT_CONTRACT_STDOUT = `## Output Contract
- Print the final result to stdout — last non-empty line is captured as the answer
- For structured data: print JSON via \`JSON.stringify(result)\` (or the language equivalent)
- For text/explanation: print plain text
- Use stderr for debug; it is not captured as the answer`;

// ── Code quality ─────────────────────────────────────────────────────────────

export const CODE_QUALITY_GENERIC = `## Code Quality
- Clear, descriptive identifiers (no single-letter names except loop indices)
- Comment non-obvious logic only — don't restate what the code says
- Handle the edge cases the input could realistically hit (empty / null / oversized)
- Fail fast with clear error messages when an invariant is violated`;

export const CODE_QUALITY_TYPESCRIPT = `## Code Quality (TypeScript)
- TypeScript strict mode for all .ts/.tsx files
- No \`any\` — type props with interfaces, narrow unknowns explicitly
- Each file ≤ 300 lines; split into modules when longer
- Wrap async operations in try/catch with typed error handling`;

// ── Error recovery ───────────────────────────────────────────────────────────

export const ERROR_RECOVERY = `## Error Recovery
- If a previous step failed, analyze the error before retrying
- Don't repeat the same approach — change strategy
- Use logging (console.log / print) to inspect intermediate values when needed`;

// ── File operation rules (for tool-calling agents that write files) ──────────

export const FILE_OPS_ATOMIC = `## File Operation Rules
- One file per tool call — never batch multiple files in a single call
- For new files: use the write tool with complete content
- For edits to existing files: use the patch tool when only a few lines change
- Verify after writing: read the file back to confirm correctness when uncertain`;

// ── Sandbox descriptions ─────────────────────────────────────────────────────

export const SANDBOX_QUICKJS = `## Sandbox Constraints
- Pure JavaScript runtime in WebAssembly
- No DOM, no browser APIs, no \`require\` / \`import\`, no \`fetch\`, no filesystem
- Available globals: Math, JSON, Array, Object, String, Number, Date, RegExp, Map, Set, Promise
- For multi-step problems: build the result incrementally with intermediate variables`;

export const SANDBOX_PYODIDE = `## Sandbox Constraints
- CPython in WebAssembly — most stdlib is available (math, json, re, itertools, collections, ...)
- numpy, scipy, pandas, matplotlib available via \`pyodide.loadPackage()\` — load on demand
- No network access, no filesystem (use in-memory data structures)
- **No GUI libraries** (tkinter, pygame, wx, Qt, curses) — they require a desktop OS and will fail
- For visualization, use matplotlib with the Agg backend and emit a base64 PNG`;

export const SANDBOX_NODE = `## Sandbox
- Full Node.js runtime: filesystem, network, npm packages on demand
- ESM \`import\` syntax preferred; CommonJS \`require\` also works
- For multi-step problems: build the result incrementally with intermediate variables`;

// ── Tool synthesis substrate ─────────────────────────────────────────────────

/**
 * Instructs the model to treat a code-execution tool as the synthesis
 * substrate: a fallback for building one-off tools inline when no
 * registered tool fits the task. Injected into the system prompt when
 * `enableToolSynthesis` is set on `ToolCallingAgent`.
 */
export function TOOL_SYNTHESIS_FRAGMENT(codeToolName: string): string {
  return (
    `\n\n# Tool synthesis (when no registered tool fits)\n` +
    `If a task needs an operation no registered tool offers, you may use \`${codeToolName}\` ` +
    `to *synthesise* a one-off tool inline. Treat \`${codeToolName}\` as the substrate for ` +
    `building what you need, not just for running pre-known scripts. Prefer this over giving up ` +
    `or repeatedly retrying a registered tool that doesn't apply. The synthesised code runs ` +
    `under the same capability manifest as the rest of the run.`
  );
}
