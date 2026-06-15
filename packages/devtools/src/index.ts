/**
 * @agentkit-js/devtools — runtime-agnostic primitives.
 *
 * Re-exports the replay engine and helper types. The React UI lives in the
 * `./react` subpath so consumers without React (eg server-side fork tools)
 * don't pay the bundle cost.
 */
export type {
  Fork,
  ForkOptions,
  LoggedEvent,
  ReplayCursor,
  ReplayStep,
} from "./EventLogReplay.js";
export { EventLogReplay } from "./EventLogReplay.js";
// D5 (2026-06): GenAI semconv → LoggedEvent adapter. Lets the Studio
// consume traces from Vercel AI SDK / Mastra / OpenAI Agents JS / etc.
export type { GenAiConversionResult, GenAiSpan } from "./genaiOtelAdapter.js";
export {
  convertGenAiSpansToEvents,
  parseGenAiInput,
} from "./genaiOtelAdapter.js";
export type { RunSummary, RunsRollup } from "./RunsAggregator.js";
// A4 (S3, 2026-06): runs-overview aggregation. Pure-logic; reads from any
// LoggedEvent source (EventLog, custom KV, JSON file). Fed into the local
// Studio's metrics card by `packages/devtools/src/react/RunsOverview.tsx`.
export { groupByTraceId, rollupRuns, summariseRun } from "./RunsAggregator.js";
