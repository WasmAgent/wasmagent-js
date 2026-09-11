/**
 * Basic agent example — CodeAgent with JS kernel (default).
 *
 * Run with: ANTHROPIC_API_KEY=sk-... node index.js
 *
 * For the Pyodide (Python) kernel variant, see the comment at the bottom.
 */

import { CodeAgent, AnthropicModel } from "@wasmagent/core";
import { z } from "zod";

// Safe arithmetic evaluator — tokenizes and parses with a recursive-descent
// parser instead of Function()/eval, so a model-supplied "expression" can
// only compute numbers, never execute code.
function evaluateArithmetic(input) {
  const s = String(input).replace(/\s+/g, "");
  if (!/^[0-9+\-*/%^().]*$/.test(s)) {
    throw new Error(`unsupported characters in expression: ${input}`);
  }
  let pos = 0;

  function parseExpr() {
    let v = parseTerm();
    while (s[pos] === "+" || s[pos] === "-") {
      const op = s[pos++];
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  function parseTerm() {
    let v = parseFactor();
    while (s[pos] === "*" || s[pos] === "/" || s[pos] === "%") {
      const op = s[pos++];
      const r = parseFactor();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }

  function parseFactor() {
    if (s[pos] === "+") {
      pos += 1;
      return parseFactor();
    }
    if (s[pos] === "-") {
      pos += 1;
      return -parseFactor();
    }
    let base = parseAtom();
    if (s[pos] === "^") {
      pos += 1;
      base = base ** parseFactor(); // right-associative
    }
    return base;
  }

  function parseAtom() {
    if (s[pos] === "(") {
      pos += 1;
      const v = parseExpr();
      if (s[pos] !== ")") throw new Error("unbalanced parentheses");
      pos += 1;
      return v;
    }
    const m = /^\d+(?:\.\d+)?/.exec(s.slice(pos));
    if (!m) throw new Error(`unexpected token at position ${pos} in: ${input}`);
    pos += m[0].length;
    return Number(m[0]);
  }

  const result = parseExpr();
  if (pos !== s.length) throw new Error(`unexpected token at position ${pos} in: ${input}`);
  if (!Number.isFinite(result)) throw new Error("expression did not evaluate to a finite number");
  return result;
}

// 1. Define a tool.
const calculator = {
  name: "calculator",
  description: "Evaluates a simple arithmetic expression",
  inputSchema: z.object({ expression: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ expression }) => {
    return String(evaluateArithmetic(expression));
  },
};

// 2. Create a model.
const model = new AnthropicModel("claude-sonnet-4-6");

// 3. Create the agent (JS kernel — default).
const agent = new CodeAgent({
  tools: [calculator],
  model,
  maxSteps: 5,
});

// 4. Run and stream events.
console.log("Starting agent (JS kernel)...\n");
for await (const event of agent.run("Calculate (123 * 456) + 789")) {
  if (event.event === "final_answer") {
    console.log("Answer:", event.data.answer);
  } else if (event.event === "error") {
    console.error("Error:", event.data.error);
  }
}

/*
 * ── Pyodide (Python) kernel variant ──────────────────────────────────────────
 *
 * Swap the agent construction above for:
 *
 *   const agent = new CodeAgent({
 *     tools: [calculator],
 *     model,
 *     maxSteps: 5,
 *     actionLanguage: "pyodide",   // runs Python via CPython-in-WASM
 *   });
 *
 * The agent will then execute Python code blocks:
 *   for await (const event of agent.run("Compute sum([1,2,3,4,5])")) { ... }
 *
 * Pyodide loads on first run (~300 ms). State persists across steps.
 * Requires: pnpm add pyodide   (already in peer deps)
 */
