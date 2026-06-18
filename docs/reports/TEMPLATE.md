# evals-runner — Paired-Statistics Report Template

> Copy this file, fill in the `TBD` placeholders, and commit. The
> format matches what `renderReportMarkdown()` in `@wasmagent/evals-runner`
> produces automatically; use this template only when you need a hand-authored
> supplement (e.g., a public announcement or a human-readable narrative
> alongside the raw JSON).

---

## Headline

> **Arm A** on **Model X** (n=TBD, b=TBD, c=TBD):
> arm-wins=**TBD**, baseline-wins=**TBD**, neither=**TBD**.
> McNemar exact p = **TBD** (α=0.05). Wilson 95% CI: [TBD, TBD].

## Reproduction command

```bash
git clone https://github.com/WasmAgent/wasmagent-js
cd wasmagent-js && npm install
node examples/benchmarks/<script>.mjs \
  --base-url http://localhost:11434/v1 \
  --models   <model-id> \
  --seeds    0,1,2 \
  --out      docs/reports/<this-dir>
```

Or via the CLI:

```bash
npx @wasmagent/cli evals run \
  --suite   <suite-name> \
  --models  <id@base-url> \
  --seeds   0,1,2 \
  --report-file docs/reports/<this-dir>/REPORT.md
```

## Arms compared

| Arm | Description |
|-----|-------------|
| `baseline` | TBD — e.g. bare ToolCallingAgent, no grammar |
| `arm-X`    | TBD — e.g. CodeAgent + grammar + SC k=5 |

## Model(s)

| ID | Size | Quantisation | Source |
|----|------|-------------|--------|
| TBD | TBD | TBD | TBD |

## Dataset

| Suite | n | Judge | Seeds |
|-------|---|-------|-------|
| TBD | TBD | TBD | 0, 1, 2 |

## Results table

| Model | Arm | Pass rate | 95% CI | vs baseline | McNemar p |
|-------|-----|-----------|--------|-------------|-----------|
| TBD | baseline | TBD% | [TBD, TBD] | — | — |
| TBD | arm-X    | TBD% | [TBD, TBD] | +TBD pp | TBD |

## Interpretation

TBD — e.g. "The improvement is statistically significant (p < 0.05) and
represents a TBD pp lift in pass-rate on this benchmark. Effect size
corresponds to TBD additional tasks solved per 100."

## Caveats

- Runs on a single model family; generalisation to larger/smaller models
  requires a separate run.
- The judge is TBD — any automated judge has a false-positive rate;
  human spot-check of TBD% of failures is recommended before citing
  in external communications.
- Seed set {0,1,2} gives three independent draws; ≥5 seeds are preferred
  for publication. Re-run with `--seeds 0,1,2,3,4` to extend.

## Raw data

`raw.json` alongside this file contains the full per-item result matrix.
Load it with:

```js
import { renderReportMarkdown } from "@wasmagent/evals-runner";
import data from "./raw.json" with { type: "json" };
console.log(renderReportMarkdown(data));
```
