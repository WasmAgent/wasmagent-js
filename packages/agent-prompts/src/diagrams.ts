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

/** Card-block rule block for the JS code-agent prompt. */
export const DIAGRAMS_CODE_JS = `## Diagrams (D2 — preferred over code)
For flowcharts, architecture diagrams, sequence diagrams, ER diagrams, or state machines — output a D2 card block in your final answer instead of generating HTML/SVG/Canvas code:

\`\`\`card:d2 <optional title>
direction: right
A -> B -> C
\`\`\`

Use D2 for structural diagrams. Use HTML/Canvas code only for data charts, animations, or interactive visualizations.`;

/** Card-block rule block for the Python code-agent prompt. */
export const DIAGRAMS_CODE_PYTHON = `## Diagrams (D2 — preferred over code)
For flowcharts, architecture diagrams, sequence diagrams, ER diagrams, or state machines — output a D2 card block in your final answer instead of using matplotlib:

\`\`\`card:d2 <optional title>
direction: right
A -> B -> C
\`\`\`

Use matplotlib for data charts (bar/line/scatter/heatmap). Use D2 for structural/relational diagrams.`;
