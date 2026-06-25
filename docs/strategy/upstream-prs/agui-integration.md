# WasmAgent integration for ag-ui-protocol/ag-ui

**Target repo**: `ag-ui-protocol/ag-ui`
**Draft date**: 2026-06-25
**Status**: 📋 ISSUE DRAFT — must open issue first, await maintainer assignment

---

## Issue body (to post at github.com/ag-ui-protocol/ag-ui/issues/new)

**Title**: `[Integration] WasmAgent — WASM-sandboxed agent runtime with governance`

---

### What is WasmAgent?

[WasmAgent](https://github.com/WasmAgent/wasmagent-js) is a TypeScript agent runtime
with WASM-sandboxed code execution, capability manifests, and compliance verifiers.
It adapts to Vercel AI SDK, OpenAI Agents JS, LangChain.js, Claude Agent SDK, and
Mastra via published adapter packages.

### What `@wasmagent/ag-ui` provides

`@wasmagent/ag-ui` (`npm install @wasmagent/ag-ui @wasmagent/core`) exposes any
WasmAgent agent over the AG-UI frame protocol as a streaming HTTP handler:

```ts
import { createAgUiHandler } from "@wasmagent/ag-ui";
import { ToolCallingAgent } from "@wasmagent/core";

const agent = new ToolCallingAgent({ model, tools });
export default { fetch: createAgUiHandler(agent) };
```

**Event mapping** (all 16 AG-UI event classes covered):

| WasmAgent `AgentEvent` | AG-UI event(s) |
|---|---|
| `run_start` | `RUN_STARTED` |
| `tool_call` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` |
| `tool_result` | `TOOL_CALL_RESULT` + `TOOL_CALL_END` |
| `final_answer` | `TEXT_MESSAGE_*` + `RUN_FINISHED` |
| `error` | `RUN_ERROR` |
| `await_human_input` | `STATE_DELTA` + `STEP_FINISHED` |
| thinking / planning | `THINKING_*` chunks |

**Extensions**: `resume` (session replay from KV), `context` (structured context injection),
`parentRunId` (nested-run tracing).

### What I'd contribute

Per CONTRIBUTING.md: a full integration PR including:

1. `integrations/wasmagent/typescript/` — `createAgUiHandler` + dojo-compatible server
2. `examples/` — minimal runnable example
3. Dojo registration: `agents.ts`, `menu.ts`, `env.ts`
4. Dojo scripts: `prep-dojo-everything.js`, `run-dojo-everything.js`
5. E2e tests: `apps/dojo/e2e/tests/wasmagent/`
6. CI config: matrix entry in `dojo-e2e.yml`
7. `CODEOWNERS` entry for `integrations/wasmagent/`

I'll maintain this integration going forward.

### Questions for maintainers

1. Is this the right time to add a new integration, or is the integrations directory frozen?
2. Any preferred port range for the dojo server (checking against existing integrations)?
3. Is type-compatibility with `@ag-ui/core` (no runtime dep, local mirrors) acceptable,
   or should the integration wait for the stable release?

---

## Pre-submission checklist

- [ ] Verify `@ag-ui/core` version still `0.0.57` on day of issue filing
- [ ] Check existing dojo port assignments to avoid collision
- [ ] Read latest CONTRIBUTING.md change for any new requirements
- [ ] Confirm `@wasmagent/ag-ui` smoke test passes against latest `@ag-ui/core` alpha

## Re-pitch condition

If maintainer responds "not accepting new integrations yet", wait for `@ag-ui/core` stable
release and re-pitch. Do not re-open a closed thread.

## References

- Package: `@wasmagent/ag-ui` at `packages/ag-ui/` in this repo
- Event mapping table: `packages/ag-ui/README.md`
- AG-UI CONTRIBUTING.md checklist: https://github.com/ag-ui-protocol/ag-ui/blob/main/CONTRIBUTING.md
