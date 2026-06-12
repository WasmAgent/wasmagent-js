# bscode × local-LLM — model selection guide (2026-06-12)

Real-machine benchmark across 7 bscode-realistic scenarios on Apple Silicon Metal.
Full per-scenario table: [`bench-bscode-local-models-2026-06-12.md`](./bench-bscode-local-models-2026-06-12.md).

## TL;DR

| Tier | Pick | Why |
|---|---|---|
| Speed-first dev/CI | **Qwen2.5-0.5B q4_0** (398 MB) | 4/7 pass, ~50 t/s, loads in 388ms — good for trivial tool calls + structured JSON + Chinese. Falls over on multi-arg tool selection and "don't call any tool" steering. |
| Balanced default | **evo-Qwen3-1.7B q3_k_m** (940 MB) | **7/7 pass**, ~34 t/s. Sub-1GB, handles multi-arg tools, shell commands, "no tool" rejection. Best speed/quality ratio under 1GB. |
| Best small-model quality | **evomerge-Qwen2.5-1.5B** (1.6 GB) | **7/7 pass**, ~33 t/s. Slightly larger but no quality regression vs the 1.7B q3km. Picks sensibly default to this when RAM allows. |

## What the scenarios test

| ID | Scenario | What's hard about it |
|---|---|---|
| S1 | Trivial tool pick | Baseline — should be 100% with grammar |
| S2 | Pick among 4 tools | Needs the model to read tool descriptions, not just match the first |
| S3 | `write_file` with content payload | Multi-arg tool call, escape-heavy string content |
| S4 | Shell command construction | Synthesise *new* string (not pulled verbatim from prompt) |
| S5 | Structured JSON via `responseFormat` | No tools — just grammar-constrained JSON output |
| S6 | Chinese prompt → English tool call | Cross-lingual instruction-following |
| S7 | "No tool fits" → final_answer | Negation: model must NOT call a tool |

## Where 0.5B falls short

| Scenario | What 0.5B did | Why it failed |
|---|---|---|
| S3 (`write_file`) | Called `read_file` instead | Confused write/read on a file that doesn't exist yet. Model picked the most "common" verb. |
| S4 (shell command) | Called `list_files`, ignored `run_command` | Couldn't synthesise the shell verb — prefers a tool whose name surfaces in the prompt. |
| S7 (no tool fits) | Called `read_file({path: "/path/to/french_capital"})` | Hallucinated a tool fit. Couldn't reject the tools when grammar still permitted `final_answer`. |

These are exactly the failure modes the cert harness's `pickedTool` vs `semanticOk` columns surface — small models with grammar produce structurally legal output but pick the *wrong* tool.

## Speed observations

- **Load time scales sub-linearly with size** on Metal: 0.5B = 388ms, 1.7B = 311ms, 1.5B = 388ms. Variance is tiny — first-class Metal mmap-and-go.
- **Tokens/second drops with size**: 0.5B = 51 t/s, 1.7B = 34 t/s, 1.5B = 33 t/s. Roughly 1/√size.
- **First-chunk == wall time** in our numbers because grammar mode collects the full output before yielding any text/tool_call event. For free-form streaming that won't be the case.
- **All wall times are sub-second**, even the slowest scenario. Single bscode agent step at "user types prompt → tool call resolved" feels instant.

## Recommended bscode integration patterns

### Pattern A — `localFirst` for cost control

```ts
import { LocalModel, localFirst } from "@agentkit-js/model-local";
import { AnthropicModel } from "@agentkit-js/model-anthropic";

const model = localFirst(
  new LocalModel({ source: { model: "qwen3-0.6b" } }),
  new AnthropicModel("claude-haiku-4-5-20251001", apiKey),
);
```

Local handles trivial tool calls (S1/S2/S5/S6) for free. Cloud catches the long tail (S3/S4/S7) where 0.5B fails. Net cost: < 30% of always-cloud, with no quality drop on hard tasks.

### Pattern B — `localOnly` for offline / dev / CI

```ts
const model = new LocalModel({ source: { model: "qwen3.5-0.8b" } });
```

Use when bscode runs on a developer laptop in airplane mode or in a CI smoke job without API budget. Stick to the 1B+ tier for full bscode tool fleet.

### Anti-pattern — 0.5B as primary on hard tasks

The 0.5B is **too small** to be the primary model for bscode's worker. Use it only for:
- Pre-routing classification ("is this a code task? a chat task?")
- Summarisation drafts that a stronger model later edits
- Free CI/dev-mode where occasional wrong tool picks are cheap to iterate

## How to reproduce

```bash
cd bscode
node scripts/benchmark-local-models.mjs --out report.md
# or one model:
node scripts/benchmark-local-models.mjs --models qwen2.5-0.5b
# or quick smoke (3 scenarios):
node scripts/benchmark-local-models.mjs --quick
```

Models must already exist on disk. The benchmark script's `MODELS` constant points at three GGUFs in the local Ollama cache; edit it to point at your own paths.

## Honest caveats

- The 1.7B and 1.5B models tested are community "evo-merge" variants — results may not generalise to vanilla Qwen3-1.7B / Qwen2.5-1.5B. Numbers should be re-collected once the model-local registry pins vetted releases.
- Token-counting is framework-side (heuristic), not engine-reported. Treat `t/s` as ±10%.
- Apple Silicon Metal benefits from unified memory; expect different shapes on Linux/CUDA (load typically slower, t/s higher on a discrete GPU).
- `process.exit()` triggers a [known llama.cpp Metal cleanup assert](https://github.com/ggml-org/llama.cpp/pull/17869) — visible in stderr but does not affect any generation result.
