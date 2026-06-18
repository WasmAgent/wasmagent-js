# DevTools — debugging your *non-agentkit* agent

> Companion to [`devtools.md`](devtools.md). That guide covers the
> agentkit-native EventLog path. **This guide assumes you are NOT
> using agentkit-js as your framework** — you are on Vercel AI SDK,
> Mastra, OpenAI Agents JS, Anthropic SDK, LangSmith-instrumented
> code, or any other producer that emits OpenTelemetry GenAI
> semantic-convention spans.

`agentkit devtools --otel-events-file <path>` reads NDJSON or
OTLP/JSON, maps `gen_ai.*` attributes onto the events the existing
Studio view consumes, and serves a self-contained HTML page on
`localhost`. No SaaS, no account, nothing leaves your machine.

If your agent is on one of the producers below, you should be able
to run a Studio view of an existing trace in under a minute.

## Prerequisites

Either:

```bash
# One-shot, no install:
npx -p @wasmagent/cli agentkit devtools --otel-events-file ./spans.ndjson

# Or globally:
npm install -g @wasmagent/cli
agentkit devtools --otel-events-file ./spans.ndjson --port 4317
```

You do **not** need to install `@wasmagent/core` for this path.
The CLI loads the devtools package lazily; the GenAI-semconv adapter
is a pure-data converter.

## Capture recipes

### Vercel AI SDK 6

`ai-sdk` ships GenAI-semconv attributes when you wire an OTel
SDK. The minimal capture:

```ts
// instrument.ts (run before your app code, e.g. via --import)
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";

new NodeSDK({
  // Console exporter is convenient because it dumps NDJSON to stdout —
  // pipe to a file and feed straight to `agentkit devtools`.
  traceExporter: new ConsoleSpanExporter(),
}).start();
```

Then:

```bash
node --import ./instrument.ts your-app.mjs > spans.ndjson
agentkit devtools --otel-events-file ./spans.ndjson
```

(Replace the console exporter with your usual collector when you're
not in debug mode; the adapter accepts the OTLP/JSON the OTel HTTP
exporter writes too.)

### Mastra

Mastra emits GenAI-semconv via its OpenInference / OTel integration.
Point any OTel collector at the run, dump to NDJSON, and the
adapter recognises the standard `gen_ai.operation.name` values
(`invoke_agent`, `chat`, `execute_tool`).

If you only have OpenInference attributes (`llm.*` instead of
`gen_ai.*`), open an issue tagged `devtools:cross-framework` —
the adapter has a small bias toward the GenAI semconv face but the
mapping is mechanical and we'll add the missing keys.

### OpenAI Agents JS

`@openai/agents` traces work the same way; you'll see
`gen_ai.tool.name` for the tool calls and `gen_ai.agent.task` for
the agent invocation. The adapter de-duplicates spans that share
a `traceId` so an agent-then-tool-then-agent stack reads as one
run.

### Anthropic SDK direct (no framework)

If you call `client.messages.create({...})` directly, the SDK's
OTel instrumentation also emits GenAI-semconv attributes. The
adapter treats this as a single-step run and you'll still get
the cost / token / latency-p95 / error-rate aggregator over
multiple calls in the same trace.

### LangSmith-instrumented code

LangSmith exports map cleanly to GenAI semconv when you ask for
the OTel-compatible export. Run that export, feed to the adapter,
and you have a local Studio view without a LangSmith account.

## What the Studio shows

Once the page loads:

- **Runs aggregator.** Cost / token / latency-p95 / error-rate per
  trace, sortable. Useful for "which runs are blowing my budget."
- **Step replay.** Click into any trace to see step-by-step events
  in submission order, with the same fork-from-step affordance the
  agentkit-native view provides.
- **Side-by-side comparison.** Run two NDJSON files in two devtools
  sessions on different ports to A/B compare an agentkit prototype
  against your existing Vercel AI SDK / Mastra implementation. This
  is the recipe we recommend for evaluating whether to migrate any
  particular component.

## Limitations

- **Best-effort mapping.** If a producer omits the standard
  attributes, the adapter still surfaces the span but with reduced
  detail (cost / token columns may be empty). Comparing two runs
  from different producers is the use case — over-strictness would
  make that impossible.
- **No collector mode (yet).** Today the CLI ingests static files.
  An OTLP-receiver mode (live ingest from a running collector) is
  considered post-1.0; if you need it, open an issue tagged
  `devtools:live-ingest`.

## Where to take feedback

- Producer not recognized → open an issue tagged
  `devtools:cross-framework` with a redacted span sample.
- Specific attribute missing → same tag.
- Suggested capture recipe for a producer not above → PR welcome.

The point of this page is that you do not need to be an
agentkit-js user to benefit from the Studio. Cross-framework
issues land first because they are exactly the audience the package
is positioned for in
[`docs/strategy/maintenance-tiers.md`](../strategy/maintenance-tiers.md)
(`@wasmagent/devtools` is ◆ Narrative).
