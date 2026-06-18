# 2026-06 Competitive Positioning Memo

> Last refreshed: **2026-06-12**. This is the public version of the
> strategic context referenced from [`ROADMAP.md`](../../ROADMAP.md).
> Refresh quarterly; flag anything older than two quarters as stale.

This memo exists because the ROADMAP can only be opinionated about
*what we will do*. To explain *why* — and to be honest about where we
fit in the 2026 TS-agent landscape — we need a separate document that
quotes outside numbers, names competitors, and admits weaknesses.
The audience is a prospective adopter who is comparing agentkit-js
against Vercel AI SDK, LangGraph.js, OpenAI Agents JS, Mastra,
or Cloudflare Agents SDK and needs to know whether to bet on us.

---

## 1. Honest snapshot

**Technically: strong and differentiated. On distribution: nascent.**

| Axis                   | Status                                                                                                  |
|------------------------|---------------------------------------------------------------------------------------------------------|
| Code-mode runtime      | ✅ Three-tier kernel matrix (in-process / WASM / remote) actually exists; competitor kernels are single-tier |
| Prompt-cache discipline| ✅ Anthropic stable-prefix, byte-stable observer prompts, proven in `ObservationalMemory`                  |
| Quality runners        | ✅ Self-consistency / Reflect-Refine / Budget-Forcing / Parallel-Fork-Join all in `core/src/enhancement/`  |
| Statistical evals      | ✅ McNemar exact + Wilson CI + paired bootstrap in `evals-runner/src/stats` (rare in JS-land)             |
| Zero-deploy DevTools   | ✅ `agentkit devtools` CLI + RunsAggregator + EventLogReplay (no SaaS, no account)                        |
| **npm distribution**   | ⚠️ `@wasmagent/core` first published 2026-06-12 — still a single version on npm                       |
| **Bus factor**         | ⚠️ Single maintainer; no co-publishers yet                                                              |
| **Public benchmarks**  | ⚠️ Internal LongMemEval-style runs published; the official 500-question set has not yet been run         |

The technical foundation is real. The market signal is not yet visible.
This memo is about how we close that gap *without* spending the next
year reinventing what Vercel/Mastra already ship.

## 2. Where the market actually sits in 2026-06

Three observations from the field, all later than our own history:

1. **"Code-mode" has become the consensus pattern.** Cloudflare's
   2026-02 *Code Mode: give agents an entire API in 1,000 tokens*
   blog, the 2026-04 *Code Mode MCP server* GA, and Anthropic's
   *Code execution with MCP* note all land on the same shape:
   **expose tools as a typed code surface, run inside a sandbox,
   collapse the per-tool round-trip cost.** This validates S1 — the
   axis we picked for the runtime.
2. **The framework race already has a winner.** Vercel AI SDK, by
   downloads, is roughly four orders of magnitude ahead of every
   other TS-native framework. LangGraph.js is the enterprise default.
   Mastra closed a 2026-04 Series A on the back of LongMemEval and
   their Studio product. There is no remaining oxygen for a "new
   framework" pitch — there is oxygen for a *runtime* that the
   leaders embed.
3. **Selection criteria are tilting toward governance signals.**
   Pharos, MAG, Alice Labs, and the Forrester MCP brief all weight
   release cadence, security response, bus factor, and integration
   breadth equally with raw features. A repo with one npm version
   and one maintainer fails most enterprise checklists *before*
   the technical merits are scored.

## 3. The three strategic lines

The ROADMAP's S1–S4 stay; this memo refines them into three lines
the next two quarters of work must serve:

- **L1 — Become the embedded runtime.** Stop pitching the framework.
  Pitch the kernel + the manifest + the evaluator. Ship adapters into
  Vercel AI SDK, Mastra, Claude Agent SDK, and OpenAI Agents JS, and
  request inclusion in their *official* provider lists.
- **L2 — Trade self-built numbers for public-leaderboard numbers.**
  Mastra leveraged a single LongMemEval headline into the entire
  press cycle. Our reply is a *Pareto* report (accuracy × cost ×
  latency × token-efficiency × estimated J/correct) that no
  single-axis headline can dominate. Pareto is harder to spin and
  harder to ignore.
- **L3 — Make trust legible.** A co-maintainer, a CHANGELOG with a
  cadence, a 1.0 freeze face, and a public security response history
  do more for adoption today than any new feature would. They are
  cheap. We have not done them yet.

## 4. What this memo refuses to do

- **No new framework features whose only justification is "Vercel /
  Mastra has it."** Feature parity is a losing race when distribution
  is four orders of magnitude apart. Either the feature is useful to
  *us as a runtime*, or it does not ship.
- **No private benchmark headlines.** If a number cannot be
  reproduced by `examples/benchmarks/*.mjs` against a public dataset,
  it does not appear in README.
- **No promises we cannot resource.** Anything requiring sustained
  cloud spend (D2 LongMemEval-500 full run, paid security audit) is
  flagged 🖥️ in the ROADMAP so adopters know it depends on funding.

## 5. How to challenge this memo

The single fastest way to falsify this strategy is to find that
*adopters do not care* about a neutral, multi-language, multi-isolation
code-mode runtime — that they are content with whatever sandbox
Cloudflare or Anthropic ships first, even with the platform lock-in.
If by 2026-Q4 the upstream-adapter packages (`aisdk`, `mastra-sandbox`,
plus the ones added under D1) show *zero* organic downloads from the
upstream ecosystems, this memo is wrong and the runtime pitch should
be retired in favor of either a pure DevTools play or sunset.

Watch the [evals reports directory](../reports/) and the upstream
adapter download graphs; that is the signal.
