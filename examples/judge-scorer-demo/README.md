# Judge scorer demo

Side-by-side comparison of code-based scorers (`exactMatch`,
`finalAnswerLength`) and LLM-judge scorers (`trajectoryQualityJudge`,
`answerCompletenessJudge`).

## Run

```bash
node examples/judge-scorer-demo/index.mjs
```

No API key needed — the demo uses a deterministic mock judge model so it
runs offline. Real usage swaps `mockJudge(...)` for any
`@wasmagent/core` Model adapter (Haiku / Doubao / DeepSeek for cheap
judging).

## Output

Three traces are scored:

| Trace | What's special |
|---|---|
| `hello` | Trivial answer; everything scores 1.0. |
| `thirty` | Correct math; small efficiency penalty (`trajectoryQuality=0.87`). |
| `pizza` | Answer contains the keyword but skips half the task; rule-based scorers miss it, the LLM-judges catch it. |

The interesting row is **pizza**: rule-based scorers either fire
spuriously (`exactMatch` strictly fails because the answer contains
extra words) or report a non-actionable score (`finalAnswerLength`
just says "near the target length"). The LLM-judges produce the
useful verdict — coverage 4/10, actionability 3/10 — that explains
why the answer is bad, in terms a human reviewer can act on.

## See also

- [docs/guides/evals-cookbook.md](../../docs/guides/evals-cookbook.md)
- `packages/core/src/evals/JudgeScorer.ts` — implementation
- `packages/core/src/evals/JudgeScorer.test.ts` — 8 unit tests
