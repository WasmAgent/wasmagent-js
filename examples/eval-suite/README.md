# eval-suite — End-to-end agent evaluation

Demonstrates the full WasmAgent evals stack on a 3-sample arithmetic
+ factual benchmark, with a composite scorer combining correctness,
efficiency, recovery, and length constraints.

## Run

```bash
export ANTHROPIC_API_KEY=...
bun install
bun run start
```

Output: a markdown table to stdout + `./report.md`. Example:

```
| ID    | Task                  | Final | Duration | exactMatch | efficiency | overall |
|-------|-----------------------|-------|---------:|-----------:|-----------:|--------:|
| math-1 | What is 12 * 12 ...  | 144   | 850ms    | 1.000      | 1.000      | 0.95    |
```

## Customizing

Swap dataset, model, scorers, or composite weights to match your
production benchmark. See [evals-cookbook.md](../../docs/guides/evals-cookbook.md)
for design patterns.
