# basic-agent — minimal CodeAgent example

Five-line `CodeAgent` smoke test against Anthropic's API. The agent receives
a single tool (`calculator`) and is asked to compute a value; it writes
JavaScript and runs it in the default WASM kernel.

## Run

```bash
export ANTHROPIC_API_KEY=sk-…
node index.js
```

Expected output: a few `step_start` / `tool_call` / `final_answer` SSE-style
events printed to stdout, ending with the computed answer.

## What it shows

- The minimum viable surface of `@agentkit-js/core`: import `CodeAgent` and
  `AnthropicModel`, register a tool, iterate `agent.run(task)`.
- Default kernel (`VmKernel` on Node, `QuickJSKernel` on edge) handles JS
  execution without any extra setup.

## Variants

For the Python (Pyodide) kernel see the bottom of `index.js` — uncomment the
Python tool and the `kernel: pyodideKernel` option to swap.

For deeper end-to-end behaviour (multiple tools, evals, OpenTelemetry,
durable runtime) see:
- [`tool-calling-agent/`](../tool-calling-agent/) — multi-tool + MCP collection
- [`eval-suite/`](../eval-suite/) — composite scoring with `runEval`
- [`durable-runtime/`](../durable-runtime/) — checkpoint + SSE resume + HITL
