# @agentkit-js/agent-prompts

Reusable system prompt fragments + `composePrompt()` for agentkit-js — code/tool/sandbox/output-contract conventions exported as named string constants you compose into your own system prompt.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/agent-prompts
```

## Usage

`composePrompt()` joins fragments with double newlines and trims trailing whitespace — no template engine, no runtime. The fragments are typed `const` strings, so your IDE auto-completes them and a typo fails the build.

```ts
import {
  composePrompt,
  REASONING_FIRST,
  CODE_QUALITY_TYPESCRIPT,
  SANDBOX_QUICKJS,
  OUTPUT_CONTRACT_FINAL_ANSWER,
} from "@agentkit-js/agent-prompts";

const system = composePrompt([
  REASONING_FIRST,             // "## Approach (Reasoning-First)" block
  CODE_QUALITY_TYPESCRIPT,     // type-safety, no `any`, exhaustive checks
  SANDBOX_QUICKJS,             // QuickJS-specific: no node:, no native, …
  OUTPUT_CONTRACT_FINAL_ANSWER,// "Return your final answer as …"
]);

// Pass `system` to any agentkit Agent / Vercel AI SDK / Claude SDK / etc.
```

## Where it's used in this repo

- **bscode worker** ([`apps/worker/src/agents/prompts.ts`](https://github.com/WasmAgent/bscode/blob/main/apps/worker/src/agents/prompts.ts)) — composes 13 fragments (`CODE_QUALITY_TYPESCRIPT`, `SANDBOX_QUICKJS`, `DIAGRAMS_CODE_JS`, `FILE_OPS_ATOMIC`, …) into the production system prompt for bscode's CodeAgent. Each fragment is a generic agentkit-js building block; product-specific instructions (persona, `<boltThinking>` tag, WebContainers conventions) sit alongside.
- **`tests/integration/cross-package.test.ts`** — pins the contract that fragments compose without conflict and that `composePrompt()` is byte-stable across re-orderings.

## Fragment catalogue

| Category | Fragments |
|---|---|
| Approach | `REASONING_FIRST`, `STRUCTURED_PLAN` |
| Output | `OUTPUT_CONTRACT_FINAL_ANSWER`, `OUTPUT_CONTRACT_STDOUT` |
| Code | `CODE_QUALITY_GENERIC`, `CODE_QUALITY_TYPESCRIPT`, `ERROR_RECOVERY`, `FILE_OPS_ATOMIC` |
| Sandbox | `SANDBOX_QUICKJS`, `SANDBOX_PYODIDE`, `SANDBOX_NODE` |
| Diagrams | re-exported from `./diagrams` (`DIAGRAMS_CODE_JS`, `DIAGRAMS_CODE_PY`, …) |

The full surface lives in [`src/fragments.ts`](src/fragments.ts) and [`src/diagrams.ts`](src/diagrams.ts).

## Why these particular fragments

The fragments were extracted from production system prompts that survived contact with real users (bscode in production since 2026-04, agentkit's own examples in CI). Each one solves a recurring failure mode — e.g. `CODE_QUALITY_TYPESCRIPT` exists because models default to writing untyped JS; `SANDBOX_QUICKJS` exists because models attempt `require('fs')` on a kernel that has no `fs`.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors

