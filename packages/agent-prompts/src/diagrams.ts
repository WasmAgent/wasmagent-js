/**
 * Shared diagram + card-block rules used by every system prompt.
 *
 * The same set of rules is concatenated into code-agent and tool-agent
 * prompts so an agent's final answer can produce structured cards
 * (D2 diagrams, Markdown reports) instead of plain text or HTML.
 *
 * Three variants for different agent contexts:
 *   - {@link DIAGRAMS_GENERIC}    — used by tool-agent variants
 *   - {@link DIAGRAMS_CODE_JS}    — used by JS code-agent (no matplotlib mention)
 *   - {@link DIAGRAMS_CODE_PYTHON} — used by Python code-agent (mentions matplotlib for data)
 */

/** Card-block rule block for tool-calling / framework agents. */
export const DIAGRAMS_GENERIC = `## Diagrams & Rich Content — use card blocks
Structural diagrams → \`card:d2\`. Formatted docs/tables/summaries → \`card:markdown\`.

\`\`\`card:d2 <title>
direction: right
A -> B
\`\`\`

\`\`\`card:markdown
## Title
| A | B |
|---|---|
\`\`\`

Use card blocks in your final answer when delivering diagrams or formatted documentation.
Use plain code files (write_file) only for: charts needing interactivity, animations, app source files.`;

// Triple-backtick literal — used inside the prompt strings below to
// describe what the final-answer string must contain. Avoids escaping
// hell when nesting fenced blocks inside a template literal.
const FENCE = "```";

/** Card-block rule block for the JS code-agent prompt. */
export const DIAGRAMS_CODE_JS = `## Diagrams (D2 — preferred over code)
For flowcharts, architecture diagrams, sequence diagrams, ER diagrams, or state machines — output a D2 card block as the final answer instead of generating HTML/SVG/Canvas code.

The final-answer string MUST be a fenced ${FENCE}card:d2 block. Wrap it in a JS template literal so the fences survive:

${FENCE}javascript
__finalAnswer__ = [
  "${FENCE}card:d2 Deployment Pipeline",
  "direction: right",
  "A -> B -> C",
  "${FENCE}"
].join("\\n");
${FENCE}

Use D2 for structural diagrams. Use HTML/Canvas code only for data charts, animations, or interactive visualizations.`;

/** Card-block rule block for the Python code-agent prompt. */
export const DIAGRAMS_CODE_PYTHON = `## Diagrams (D2 — preferred over code)
For flowcharts, architecture diagrams, sequence diagrams, ER diagrams, or state machines — output a D2 card block as the final answer instead of using matplotlib.

The final-answer string MUST be a fenced ${FENCE}card:d2 block:

${FENCE}python
__final_answer__ = "\\n".join([
    "${FENCE}card:d2 Deployment Pipeline",
    "direction: right",
    "A -> B -> C",
    "${FENCE}",
])
${FENCE}

Use matplotlib for data charts (bar/line/scatter/heatmap). Use D2 for structural/relational diagrams.`;
