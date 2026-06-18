# agentkit-js — Development Guide for Claude

## Test Commands

**IMPORTANT: This project uses `bun test` (not `npx vitest run`, not `npm test`).**

```bash
# Run all tests from repo root
bun test packages/core/src/
bun test packages/cloudflare-worker/src/ --isolate   # --isolate prevents cross-file async leakage
bun test packages/cli/
bun test packages/model-anthropic/src/
# etc.

# DevTools (React/DOM tests) MUST be run from within the package directory:
cd packages/devtools && bun test

# Run a specific test file
bun test packages/core/src/agents/ToolCallingAgent.test.ts
```

**Why devtools is different**: It needs DOM environment (happy-dom). The `bunfig.toml` in
`packages/devtools/` configures this via a preload script (`src/setup-dom.ts`), but Bun only
reads `bunfig.toml` from the CWD where `bun test` is invoked.

**Why `--isolate` for cloudflare-worker**: The SSE resume test leaves a pending async operation
that pollutes the next file's test run. `--isolate` runs each test file in a fresh global context.

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

