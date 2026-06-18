# Draft: Cloudflare Agents docs — third-party `codemode` executor

**Target repo:** [`cloudflare/agents`](https://github.com/cloudflare/agents)
**Target path:** `packages/agents/docs/codemode.md` (or wherever the
codemode docs live at submission time — the developer docs at
[developers.cloudflare.com/agents/api-reference/codemode](https://developers.cloudflare.com/agents/api-reference/codemode)
mirror the package's source-of-truth doc).
**Status:** **FILED 2026-06-17** — issue [cloudflare/agents#1771](https://github.com/cloudflare/agents/issues/1771) opened (PR creation is gated to collaborators on `cloudflare/agents`; per the fallback in §Pre-submission to-do, opened as `community-recipe` issue with the patch ready to cherry-pick from [telleroutlook/agents@community-recipe-agentkit-byo-executor](https://github.com/telleroutlook/agents/tree/community-recipe-agentkit-byo-executor)). Direction 1 of the 2026-06-12
optimization brief explicitly calls this out as the highest-leverage
upstream entry: the Cloudflare codemode docs already say the
`DynamicWorkerExecutor` is "just one implementation" and that users
"can build their own executor for Node VM, QuickJS, containers, or
any other sandbox." `@wasmagent/kernel-quickjs` + `@wasmagent/aisdk` is the missing
link for non-Cloudflare environments and Python execution.

## Why this is the priority entry

The Cloudflare codemode design explicitly leaves a hole:

1. **Approval semantics.** Tools marked `needsApproval: true` are
   stripped from the executor entirely rather than pause-and-wait.
   Real agent products need pause-and-wait.
2. **Platform binding.** `DynamicWorkerExecutor` requires a
   Cloudflare Workers environment. Cross-platform deployments
   (Node, Bun, Vercel, AWS Lambda) need a different executor.
3. **Language scope.** JS only. Python execution at the edge is a
   real ask for data-analysis agents.

agentkit-js' kernels fill all three holes:

- `kernel-quickjs` runs anywhere (it *also* runs on CF Workers);
  no platform binding.
- `kernel-pyodide` adds Python.
- agentkit's `needsApproval` lifecycle is a first-class concept
  in `core` (`Tool.needsApproval` + `await_human_input` step).

So the right ask is *not* "rewrite the docs" — it is "add a one-page
recipe page that points users to a third-party executor that closes
those three gaps, exactly as the docs say is intended."

## Proposed shape (recipe page)

A new page under the codemode docs, ~50 lines:

````markdown
# Bring-your-own executor: agentkit-js kernels

The `DynamicWorkerExecutor` is the default; codemode is designed
for any executor that conforms to the `CodeExecutor` contract.
The community-maintained `@wasmagent/kernel-*` packages
provide three executors that close gaps in the default:

| Use case                           | Executor                         | Adds                                        |
|------------------------------------|----------------------------------|---------------------------------------------|
| Run codemode off Cloudflare        | `@wasmagent/kernel-quickjs`    | Cross-platform JS sandbox (Node/Bun/Vercel) |
| Python execution at the edge       | `@wasmagent/kernel-pyodide`    | CPython-in-WASM (CFW-compatible)            |
| Full process isolation             | `@wasmagent/kernel-remote`     | E2B / Cloudflare Sandbox microVM tier       |
| Pause-on-approval lifecycle        | `@wasmagent/core`              | `needsApproval` + `await_human_input`       |

## Minimal example

```ts
import { Agent } from "@cloudflare/agents/codemode";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { agentkitCodemodeExecutor } from "@wasmagent/aisdk"; // see note

const agent = new Agent({
  // Same tools, same prompt — only the executor changes.
  tools: { /* … */ },
  executor: agentkitCodemodeExecutor({
    kernel: new QuickJSKernel(),
    // Honor the same security policy face Cloudflare's executor uses.
    capabilities: { allowedHosts: ["api.example.com"], cpuMs: 5000 },
  }),
});
```

> **Note:** the `agentkitCodemodeExecutor` shim is a thin adapter
> in `@wasmagent/aisdk` (PR pending) that wraps any agentkit
> `Kernel` in the `CodeExecutor` contract. It honors the manifest's
> `allowedHosts` / `cpuMs` / `memoryLimitBytes` consistently across
> the three kernel tiers; see
> [`docs/kernels/comparison.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md)
> for the matrix.

## When to keep the default executor

- You're entirely on Cloudflare Workers + JS-only tools and don't
  need approval semantics. The default is the simplest path.

## When the agentkit kernels are the better fit

- You deploy the same agent to CF Workers *and* Node — kernel-quickjs
  runs in both.
- Any tool needs `needsApproval: true` (paused workflows).
- A subset of tools call into Python (data analysis, scientific).
````

The page is honest: it does not claim agentkit replaces
`DynamicWorkerExecutor` — it closes the three explicit gaps the
Cloudflare docs themselves call out.

## How to file

Per the upstream's `CONTRIBUTING.md`, the right entry is a small
PR against `cloudflare/agents`. The PR body should:

1. Reference the **specific sentence** in the existing codemode
   doc that says "you can build your own executor."
2. Quote the **two gaps** in the default that the recipe addresses:
   approval, platform-binding, language scope.
3. Link to the agentkit-js repo + Apache-2.0 license badge.
4. Acknowledge that the maintainer may prefer to keep this as an
   external link or to inline only a sentence — *whichever shape
   they accept is the win*. The point is the link from the
   official docs, not the page real estate.

## Acceptance criteria for "this PR worked"

- Merged or referenced from the official docs (a single sentence
  + link is acceptable; full recipe page is the stretch goal).
- Inbound stargazers / weekly downloads on
  `@wasmagent/kernel-quickjs` show a traceable shift after
  inclusion.
- Listed in the Cloudflare codemode page as a community-maintained
  executor.

## Pre-submission to-do

1. ✅ **Done (2026-06-17)** — `agentkitCodemodeExecutor` shim shipped in `@wasmagent/aisdk@0.1.0`. 412-line implementation with a marker-rerun execution loop honouring CF's `Executor` contract verbatim. 10 tests cover flat-Record + namespaced provider surfaces, positional vs object args, console.log capture, tool-throw surfacing, unknown-tool fail-fast, and `maxIterations` runaway bound. Source: [`packages/aisdk/src/codemodeExecutor.ts`](../../../packages/aisdk/src/codemodeExecutor.ts).
2. **Verify on submission day** — the `CodeExecutor` interface name churned during CF codemode's GA stabilization. Re-check the SDK source the day this PR is filed; if the `Executor` shape moved, bump the structural copy in `codemodeExecutor.ts` and ship a patch release.
3. **Fallback path** — if the maintainer says "we don't take third-party recipes inline," open an issue tagged `community-recipe` with the same content as §"PR body" below. The discoverable artifact wins regardless of inclusion form.

## PR body (ready to paste into cloudflare/agents)

> **Title:** `docs: bring-your-own executor recipe — agentkit-js kernels for cross-platform / Python / approval-gated codemode`
>
> **Body:**
>
> The codemode docs already note that `DynamicWorkerExecutor` is one implementation and that users can supply their own. This PR adds a one-page recipe pointing at `@wasmagent/aisdk`'s `agentkitCodemodeExecutor`, which closes three explicit gaps the default leaves:
>
> 1. **Platform binding.** `DynamicWorkerExecutor` requires a Cloudflare Workers runtime; the agentkit shim runs on Node, Bun, Vercel, and Lambda (it also runs on CF Workers — same code path).
> 2. **Language scope.** JS-only today; swap `QuickJSKernel` for `PyodideKernel` to add CPython-in-WASM at the edge.
> 3. **Approval semantics.** Tools marked `needsApproval: true` are stripped today rather than pause-and-wait. agentkit's tool registry surfaces a first-class `await_human_input` step.
>
> The shim is Apache-2.0, structurally typed against the `Executor` contract (no hard dep on `@cloudflare/codemode`), and shipped in [`@wasmagent/aisdk@0.1.0`](https://www.npmjs.com/package/@wasmagent/aisdk). 10 tests green. Source: <https://github.com/WasmAgent/wasmagent-js/blob/main/packages/aisdk/src/codemodeExecutor.ts>.
>
> Whichever shape the recipe lands in is the win:
> - **Stretch:** new page under codemode docs with the table + example below.
> - **Acceptable:** single sentence + outbound link in the existing executor docs.
> - **Fallback:** an issue tagged `community-recipe` so users searching for "non-Workers executor" or "Python codemode" can find it.

## Why-not (devil's advocate)

- The Cloudflare team may prefer to roadmap their own non-Workers
  / Python paths rather than recommend a third-party. That is a
  valid maintainer decision; the falsifiability test in the
  strategy memo is exactly "do upstream maintainers actually
  accept these contributions?" A clean rejection is a useful data
  point.
- A landed PR could amplify a *competing* third-party kernel if
  someone else lands first. Treat that as fine: the goal is
  cross-platform codemode existing as an option, not lock-in to
  agentkit.

## Tracking

This draft will be moved into the `Submission record` table in
[`README.md`](README.md) when filed. If we later decide *not* to
file (e.g. a Cloudflare-built non-Workers executor lands first),
this draft stays in the directory as a record of the call we made
and why.
