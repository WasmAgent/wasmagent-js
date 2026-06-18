# CLI Gap Analysis — 2026-06-18

**Status:** living document. Update whenever a CLI is added or a known
gap is closed.

## Why this matters

A CLI is not just a "way to run tests". For agentkit-js it's a **product
surface**: anyone who writes `npx @agentkit-js/<thing> --help` lands in
a contract that compares directly against `smolagent`, `lazygit`-style
tools, and the reference CLIs every framework ships. Missing or
broken CLIs leak the same signal as a broken homepage button — "is this
project alive?".

This file inventories the current CLI surface, names the gaps, and
priorities them by *user-visible product impact* (not by how interesting
the implementation is).

## What we ship today (2026-06-18)

| Package                  | bin name                | Purpose                                                                 | Status |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------- | ------ |
| `@agentkit-js/cli`       | `agentkit`              | Multi-subcommand: `run`, `init-tool`, `devtools`, `evals`, `model`      | ✅ live |
| `@agentkit-js/mcp-server`| `agentkit-mcp-server`   | stdio JSON-RPC MCP server entry                                         | ✅ live |
| `@agentkit-js/evals-runner`| `agentkit-evals`      | Independent evals CLI                                                   | ❌ **DEAD LINK** — `bin` declared, `dist/cli.js` does not exist |

`agentkit evals run --suite=… --models=…` works today via `@agentkit-js/cli`
(`evalsCommand` at `packages/cli/src/index.ts:753`). The independent
`agentkit-evals` binary, however, is broken: anyone who reads
`packages/evals-runner/package.json` will see the bin and try to use
it; the install will fail at the symlink stage.

## Top gaps, ranked by product impact

### G1 — `agentkit-evals` bin is a dead link 🔴

**Symptom.** `bin: "agentkit-evals": "./dist/cli.js"` in
`packages/evals-runner/package.json`, but `src/cli.ts` does not exist
and the build never produces the file. `npm install -g
@agentkit-js/evals-runner` succeeds; `agentkit-evals --help` then
fails with `command not found` or a missing-file error depending on
the platform.

**Fix.** Implement `packages/evals-runner/src/cli.ts` as a
self-contained binary that mirrors `agentkit evals run/list` without
requiring `@agentkit-js/cli` to be installed. Targets users who only
want the evals runner (CI matrix runners, eval-only consumers).

**Status.** Tracked; landing in this PR.

### G2 — No `agentkit goal` subcommand 🟠

**Context.** `GoalDirectedAgent` (shipped 2026-06-18, see
`docs/guides/goal-directed.md`) is the new "eighth axis" of
agentkit's differentiation. There is currently **no way** to invoke
it from the CLI. `agentkit run` instantiates a `CodeAgent`; users
who want goal-directed behaviour have to write their own driver.

**Fix sketch.** `agentkit goal "<task>" --max-iterations 5
--judge-samples 3 [--workspace ./tmp]` runs `GoalDirectedAgent`
against the local filesystem (with a default scout snapshot from
the cwd), prints criteria + iteration timeline + final outcome.

**Why this matters.** A new flagship feature that ships *only* as a
library API has zero discovery surface. People who run
`agentkit --help` won't know it exists.

**Priority.** Strong yes — the only reason to hold this back is
not to bloat the CLI; the test is whether the option is
`smolagent`-style "I can ship a hard task and the CLI will keep
trying until it actually delivers". That's exactly what `goal` is
for.

### G3 — No `agentkit verify` subcommand 🟡

**Context.** `VerificationPipeline` and the verifier protocol
(`packages/core/src/agents/verifiers/`) are also new. The same
deterministic checks (`file_size_min`, `headings_count_min`,
`word_count_min`, `file_matches`) are useful **outside** an agent
loop — as a one-shot CLI to gate an artifact in CI or a post-commit
hook. Today they only exist as a library import.

**Fix sketch.** `agentkit verify --criteria criteria.json --root .`
takes a JSON file of `Criterion[]` and reports per-criterion verdicts
+ aggregated pass/fail. Exit code 0/1 makes it CI-droppable.

**Why this matters.** This is the cheapest possible "agentkit ships
a useful thing without an LLM" move. Doesn't even require an API
key. Every docs/eng team that writes Markdown has a use case.

**Priority.** Yes; low cost.

### G4 — No `agentkit scout` subcommand 🟡

**Context.** Phase-0 scout (tool list + workspace tree + memory hints)
is a separable capability — useful for non-agent tasks like "give me
a JSON snapshot of this project". Lives inside `GoalDirectedAgent`
today, not exposed.

**Fix sketch.** `agentkit scout [--root .] [--mcp <url>]` prints
a JSON `ScoutSnapshot` to stdout. Drops cleanly into a pipeline.

**Priority.** Medium. Niche but cheap.

### G5 — Per-package CLIs that *would* improve discoverability 🟡

| Package           | Possible CLI                                                                     | Why a binary is better than docs |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------- |
| `kernel-quickjs`  | `agentkit-quickjs run script.js`                                                 | Reproduces a sandbox locally for debugging an agent's tool call. |
| `kernel-pyodide`  | `agentkit-pyodide run script.py`                                                 | Same. Especially useful when an agent's pyodide invocation fails — operator runs the same script directly. |
| `kernel-wasmtime` | `agentkit-wasmtime run …`                                                        | Same. |
| `tools-browser`   | `agentkit-browser navigate <url>`                                                | Smoke-test the Playwright/CDP bridge without the agent loop. |
| `model-local`     | (already has `agentkit model` subcommand) ✅                                      | n/a |
| `devtools`        | (has `agentkit devtools` subcommand) ✅                                          | n/a |

**Priority.** Low individually; collectively they are the
discoverability boost on the package landing pages. Defer to a single
"v0.4 CLI surface" PR rather than nibbling.

### G6 — `agentkit init` should bootstrap a project, not (only) a tool 🟡

**Today.** `agentkit init` aliases to `init-tool` and scaffolds a single
`ToolDefinition` skeleton. Useful but not what most users expect from
`init` in 2026.

**What people expect from `init`.** A starter project: `package.json`,
TypeScript config, an example agent that runs, a README pointing at
the docs. `npx create-agentkit-app` style.

**Fix sketch.** `agentkit init <project-name>` → scaffolds an example
agent + tools + a `npm run agent "<task>"` script. Keep `init-tool`
as the canonical scaffold-a-single-tool command.

**Priority.** Medium. Worth doing before 1.0 (2026-12-15).

### G7 — `agentkit run` doesn't accept stdin tasks 🟢

**Context.** Pipelines like `cat task.txt | agentkit run` should work.
Today the CLI requires the task as a positional arg.

**Fix sketch.** When positional task is missing AND stdin is not a
TTY, read the task from stdin. Five-line change.

**Priority.** Low complexity, high quality-of-life.

### G8 — No machine-readable JSON output mode 🟢

**Context.** All agentkit CLI output is human-formatted. CI tools that
want to gate on results have to parse text.

**Fix sketch.** Add `--json` to all subcommands; emit
`{ events: AgentEvent[], answer, exitReason }` on stdout. Makes the
CLI scriptable.

**Priority.** Defer to v0.4 alongside the per-package CLIs (G5).

## Anti-gaps — things deliberately NOT shipped as CLIs

These are listed so future contributors don't redo the analysis:

- **kernel-remote** — connecting to a remote sandbox is a stateful
  multi-turn operation; `agentkit run --kernel=remote …` is the right
  surface, not a separate `agentkit-remote-shell`.
- **a2a, ag-ui, react** — protocol/runtime adapters; CLI would be
  contrived. Their `npm install` IS the install.
- **All `model-*` adapters** — already covered by `agentkit run --model`.

## Suggested PR order

1. **G1** (this PR) — fix the dead link. Free reputation win.
2. **G2** + **G3** (next PR) — `agentkit goal` + `agentkit verify` ship
   the new eighth-axis primitive at the CLI layer; together with G1
   they round out the 2026-06-18 release story.
3. **G4** — `agentkit scout`, when someone asks for it.
4. **G6** — `agentkit init` overhaul, before 1.0.
5. **G5** — per-package CLIs as a single batch.
6. **G7** + **G8** — quality-of-life; ride along with G5.

## Provenance

This document was authored on the day `GoalDirectedAgent` shipped
(2026-06-18) — the work that makes G2/G3 high-leverage. The scan was
mechanical: `for d in packages/*; do grep -c '"bin"' "$d/package.json";
done` plus a read of every package description. Cross-checked against
`packages/cli/src/index.ts`'s `case` arm for `evals` / `devtools` /
`model` to confirm what's "shipped via the multi-tool" vs "not
shipped".

When updating this file, keep the Top-gaps table sorted by user-impact,
not by implementation difficulty.
