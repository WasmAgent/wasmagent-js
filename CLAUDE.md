# wasmagent-js — Development Guide for Claude

## Test Commands

**IMPORTANT: This project uses `bun test` (not `npx vitest run`, not `npm test`).**

```bash
# Run all tests from repo root
bun test packages/core/src/
bun test packages/cloudflare-worker/src/   # --isolate is baked into bunfig.toml, no flag needed
bun test packages/cli/
bun test packages/model-anthropic/src/
# etc.

# DevTools (React/DOM tests) MUST be run from within the package directory:
cd packages/devtools && bun test

# Run a specific test file
bun test packages/core/src/agents/ToolCallingAgent.test.ts

# RLAIF-specific test suites
bun test packages/core/src/enhancement/RolloutForkRunner.test.ts
bun test packages/core/src/ranking/RolloutRanker.test.ts
bun test packages/core/src/executor/KernelPool.test.ts
bun test packages/core/src/agents/verifiers/BuildPassesVerifier.test.ts
```

**Why devtools is different**: It needs DOM environment (happy-dom). The `bunfig.toml` in
`packages/devtools/` configures this via a preload script (`src/setup-dom.ts`), but Bun only
reads `bunfig.toml` from the CWD where `bun test` is invoked.

**cloudflare-worker isolation**: The SSE resume test leaves a pending async operation that would
hang the process at ~90% CPU forever. `packages/cloudflare-worker/bunfig.toml` sets
`isolate = true` permanently — `bun test` is safe to call without any extra flags.

**CRITICAL: Never run any `bun test` as a background task** (`run_in_background`) — a hung test
will silently burn CPU for hours with no way to detect it.

## Lint

```bash
npx biome check packages/
npx biome check --write packages/    # auto-fix
```

## Build

```bash
npm run build          # build all packages via turbo
```

## Typecheck

```bash
npm run typecheck      # turbo run typecheck across all packages
```

## Integration tests

```bash
bun test tests/integration/
```

## Key new packages (2026-06-22 RLAIF)

| Module | Location |
|---|---|
| `RolloutForkRunner` | `packages/core/src/enhancement/RolloutForkRunner.ts` |
| `RolloutMemoryStore` | `packages/core/src/enhancement/RolloutMemoryStore.ts` |
| `KernelPool` | `packages/core/src/executor/KernelPool.ts` |
| `BuildPassesVerifier` | `packages/core/src/agents/verifiers/BuildPassesVerifier.ts` |
| `VisualAssertVerifier` | `packages/core/src/agents/verifiers/VisualAssertVerifier.ts` |
| `ScalarLLMJudgeVerifier` | `packages/core/src/agents/verifiers/ScalarLLMJudgeVerifier.ts` |
| `RolloutRanker` | `packages/core/src/ranking/RolloutRanker.ts` |
| `summarizeToolOutput` | `packages/core/src/agents/ToolOutputSummarizer.ts` |
| `RemoteSandboxKernel.runCommand` | `packages/kernel-remote/src/RemoteSandboxKernel.ts` |

