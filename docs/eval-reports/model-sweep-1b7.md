# evomerge t10-1b7 Model Sweep — Tool Calling Accuracy
Generated: 2026-06-23 23:32:54

## Setup
- Ollama endpoint: `http://localhost:11434`
- Tool: `add(a, b)` — returns `a + b` as a string
- Tasks: 3 addition problems
- Scoring: 1.0 = correct answer, 0.5 = tool called (wrong answer), 0 = no tool call
- Per-model timeout: 30s per inference call

## Results

| Model | 3+4=7 | 10+15=25 | 100+200=300 | Score |
|---|---|---|---|---|
| evomerge-t10-1b7-v7f | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | 0.0/3 |
| evomerge-t10-1b7-v8 | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | 0.0/3 |
| evomerge-t10-1b7-v9a | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | 0.0/3 |
| evomerge-t10-1b7-v10 | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | NO_TOOL_SUPPORT | 0.0/3 |

## Score Legend
- `PASS(n)` — correct answer, tool was called (1.0 pts)
- `TOOL_WRONG(n)` — tool called but answer incorrect (0.5 pts)
- `FAIL(n)` — no tool call, incorrect answer (0 pts)
- `NO_TOOL_SUPPORT` — Ollama 400: model chat template does not support tool-calling (0 pts)
- `TIMEOUT` — no response within 30s (0 pts)
- `N/A` — model not loaded in Ollama

## Findings
- **All models returned `NO_TOOL_SUPPORT`**: Ollama's structured output parser cannot process these models' chat templates for tool-calling.
- **Tool-calling DPO evaluation not possible** via Ollama OpenAI-compatible endpoint for evomerge-t10-1b7 models.
- **Recommended next step**: Evaluate tool-calling ability using a model with a compatible chat template (e.g. qwen2.5 or gemma4 base), or test evomerge models on direct generation tasks (QA without tools).

## Methodology Notes
- Models tested sequentially to avoid GPU memory contention.
- Scores are based on `finalAnswer` content matching expected values.
- Tool-call detection uses the `tool_call` event in the agent trajectory.
- Results are observational — no statistical significance testing performed.
