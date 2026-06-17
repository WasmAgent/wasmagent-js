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
export const DIAGRAMS_GENERIC = `## Diagrams & Documents — use card blocks for produced artefacts only

**Two trigger conditions for card blocks** — and only these two:

1. **Structural diagram** the user asked for → wrap in \`card:d2\`.
2. **Document the user explicitly asked you to produce** ("write a report",
   "draft a spec", "make a proposal", "generate the meeting notes") →
   output the complete document in Markdown wrapped in \`card:markdown\`,
   so the UI can render it as a downloadable artefact (DOCX / PDF export).

**Plain conversational replies — including ones that happen to use
headings, lists, bold spans, or short tables — render inline as
Markdown in the chat.** DO NOT wrap them in card blocks. A greeting,
an explanation, a code review note, a status summary embedded in chat
all stay as plain Markdown. Cards collapse into placeholders that
obscure the content; reserve them for first-class artefacts.

\`\`\`card:d2 <title>
direction: right
A -> B
\`\`\`

\`\`\`card:markdown <title>
# Weekly Status Report
## Highlights
…
\`\`\`

If unsure whether the user is asking for a "document" vs. an
"explanation": did the user use a verb like *write / draft / generate
/ produce / create*, with a noun like *report / doc / spec / proposal
/ slides / notes*? If yes → \`card:markdown\`. Otherwise → plain
inline Markdown.

Use plain code files (write_file) only for: charts needing
interactivity, animations, app source files.`;

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
