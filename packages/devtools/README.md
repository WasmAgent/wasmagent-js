# /devtools

> **Maturity: beta** — API shape may change in minor versions; changes announced in CHANGELOG.

**Zero-deploy local Studio for any GenAI-OTel agent trace.**

> 🆕 **Framework-agnostic.** Works on Vercel AI SDK, Mastra, OpenAI Agents JS, Anthropic SDK, LangSmith-instrumented runs, *and* wasmagent's own `EventLog`. If your agent emits [OpenTelemetry GenAI semantic-convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) spans (NDJSON or OTLP/JSON), this tool renders them. No SaaS. No account. No phone-home.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — but you do **not** need to use the wasmagent framework to use this.

---

## What it gives you

- **Cross-framework Studio.** Point it at a `*.ndjson` file of GenAI semconv spans from *any* producer and get a runs aggregator (cost / token / latency-p95 / error-rate) plus a step-by-step replay timeline.
- **Time-travel & fork-from-step.** Pick step N, optionally override task / model id, replay everything up to that prefix into a new run. The pure-logic core (`EventLogReplay`) is plain TypeScript — server-side fork CLIs and tests use it without React.
- **Zero hosting.** The CLI serves a self-contained inline HTML page on `localhost`. Nothing leaves your machine.

## Two ways to use it

### A — You're not on wasmagent (the cross-framework path)

You have GenAI-semconv OTel traces from Vercel AI SDK 6, Mastra, OpenAI Agents JS, Anthropic SDK, or anything else that follows the [OTel GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

```bash
# Capture spans to NDJSON via the OTel collector or your producer's exporter.
# Then:
npx -p /cli wasmagent devtools --otel-events-file ./spans.ndjson
```

The adapter accepts both NDJSON (one span per line) and OTLP/JSON (`{resourceSpans: [...]}`). It maps `gen_ai.operation.name = invoke_agent | chat | execute_tool` spans onto the same Studio view wasmagent uses for its own runs.

See [docs/guides/devtools-cross-framework.md](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/devtools-cross-framework.md) for capture recipes per framework.

### B — You're on wasmagent (the EventLog path)

```bash
npx -p /cli wasmagent devtools --events-file ./run.ndjson
```

Or embed the React UI in your own page:

```tsx
import { EventLogReplay } from "/devtools";
import { DevTools } from "/devtools/react";
```

See [docs/guides/devtools.md](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/devtools.md) for the embed story.

## Install

You only need `/devtools` for embed; `/core` is optional unless you call into the `EventLog` primitives directly:

```bash
npm install /devtools          # engine + react UI
# or:
npm install -g /cli            # CLI wrapper around `devtools`
```

For pure CLI use, `npx -p /cli wasmagent devtools …` works without a global install.

## Why this exists, framed honestly

Mastra Studio and Vercel AI SDK DevTools each ship a polished panel — but bound to their framework. wasmagent already emits GenAI-semconv attributes alongside the legacy ones, and the adapter (`convertGenAiSpansToEvents`) reads any producer that does the same. That puts this package in a position the bigger framework studios *cannot* fill without breaking their own boundary: a neutral local Studio that surveys runs across the framework you actually have.

If you find this useful and you don't otherwise use wasmagent, that is exactly the point — and we'd love to hear about it: tag your issue `devtools:cross-framework` so we can prioritize the producers users actually have.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
