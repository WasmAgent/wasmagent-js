# benchmarks — reproducible verification of README claims

C1 — every percentage in the [agentkit-js README](../../README.md) "Differentiating
features" section is checked here against a deterministic, model-free harness so
anyone can clone the repo and run them in CI without an Anthropic API key.

## What's verified

| Claim (README ref) | Script | Verifies |
|---|---|---|
| **PTC −37% tokens** | `ptc-tokens.mjs` | Programmatic Tool Calling vs. round-trip tool calling on a 5-tool synthetic chain |
| **Tool deferred loading −85% tokens** | `defer-loading.mjs` | System-prefix size with vs. without `deferLoading: true` on a 100-tool MCP-shaped fleet |
| **inputExamples 72→90% param accuracy** | `input-examples.mjs` | Synthetic LLM scoring on a structured-args dataset, with vs. without examples |
| **Context editing −84% tokens, +29% task perf** | `context-editing.mjs` | Token cost + task success of `assembler.editToolResults` on a saturated trajectory |

## Run

```bash
# From repo root.
pnpm install
pnpm bench                  # convenience alias
# or:
node examples/benchmarks/run-all.mjs

# Or any single benchmark:
node examples/benchmarks/ptc-tokens.mjs
```

Each script emits a markdown table to stdout AND `./report-<name>.md`. The
exit code is non-zero if any benchmark falls outside the README's claimed
ratio (±10% tolerance), making this CI-ready.

## CI gate (C1 DoD ②)

The repo's GitHub Actions workflow runs `bun run bench` after the test
matrix; any drift outside tolerance fails the PR. So the percentages in
the agentkit-js README cannot bit-rot without someone seeing it.

## Determinism

These benchmarks are intentionally **model-free**. They use:
- Counted inputs (token-equivalent character counts via the GPT-tokenizer-style
  proxy in `tokens.mjs`) — not real Anthropic API calls.
- A scripted "fake model" that returns canned responses so the trajectory is
  identical run-to-run.

The point is to verify the *mechanism* (does turning on `deferLoading` actually
strip schemas from the prefix?) not to re-measure on Anthropic's servers — the
former is what selectors care about and the latter would require credentials
plus thousands of dollars of API spend per CI run.

For end-to-end evals against a real model see `examples/eval-suite/`.
