---
title: Ecosystem Overview
description: Runtime, Reference App, and Data Factory — how the three repositories form a closed loop.
---

# Ecosystem Overview

The wasmagent ecosystem spans three repositories that work together as a single product:

```
┌────────────────────────────────────────────────────────────────┐
│                        wasmagent-js                            │
│  Agent Runtime / SDK / Kernel / Ranking / Model Adapters       │
│  • Secure WASM sandboxing (QuickJS, Pyodide, Wasmtime)         │
│  • 8+ model adapters incl. Chinese providers                   │
│  • RolloutForkRunner → training data hooks                     │
└──────────────────────┬─────────────────────┬───────────────────┘
                       │ npm packages        │ rollout JSONL
          ┌────────────▼──────────┐  ┌───────▼────────────────────┐
          │       bscode          │  │        evomerge             │
          │  Edge-native coding   │  │  Model merge / eval /       │
          │  agent template       │  │  RLAIF data factory         │
          │  • Cloudflare Worker  │  │  • TrainingDataExporter     │
          │  • React/Next.js UI   │  │  • DPO/PPO generation       │
          │  • build + visual     │  │  • Eval harness             │
          │    verification       │  │  • evomerge optimizer       │
          └───────────────────────┘  └────────────────────────────┘
```

## The three layers

| Layer | Repository | User value |
|---|---|---|
| **Runtime** | `wasmagent-js` | Secure portable agent runtime: WASM isolation, tool governance, model adapters, observability, rollout ranking |
| **Reference App** | `bscode` | One-click deployable coding agent on Cloudflare Workers — proves the runtime works end-to-end |
| **Data Factory** | `evomerge` | Converts real agent runs into DPO/PPO training data, closes the improvement loop |

## How the loop closes

```
bscode runs jobs
  → build result (pass/fail) + visual checks
  → wasmagent-js RolloutForkRunner records trajectories
  → RolloutRanker scores branches (objective + judge)
  → rollout-wire JSONL (Layer 1)
  → evomerge TrainingDataExporter
  → DPO/PPO training records (Layer 3)
  → model fine-tune / merge / eval
  → improved model back into bscode defaults
```

This loop is what separates wasmagent from a generic agent framework — it produces
**training signal from real deployments, not synthetic benchmarks**.

## Where to start

- **Using the runtime** → [Getting started with wasmagent-js](./guides/getting-started.md)
- **Deploying bscode** → [bscode README](https://github.com/WasmAgent/bscode)
- **Running the data pipeline** → [Data Pipeline guide](./data-pipeline.md)
- **Schema contract between repos** → [Schema Governance](./schemas/GOVERNANCE.md)
- **Integration smoke test** → `evomerge/tests/test_three_repo_smoke.py`

## Repository links

| Repository | Description | Docs |
|---|---|---|
| [`wasmagent-js`](https://github.com/WasmAgent/wasmagent-js) | Agent runtime, npm packages | This site |
| [`bscode`](https://github.com/WasmAgent/bscode) | Cloudflare coding agent | `bscode/README.md` |
| [`trace-pipeline`](https://github.com/WasmAgent/trace-pipeline) | Model merge + RLAIF factory | `trace-pipeline/docs/` |
