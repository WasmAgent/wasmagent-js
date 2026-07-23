/**
 * shared-state barrel export.
 *
 * @wasmagent/core/shared-state — Human-agent collaborative state management.
 */

export type { ProjectionDelta, ProjectionFn, ProjectionPipeline } from "./projection.js";
// #138 — Projection pipeline
export { createProjectionPipeline } from "./projection.js";
export type { ChangeEvent, SharedStateStoreOpts, StoreMeta } from "./SharedStateStore.js";
// #135 — SharedStateStore
export { SharedStateStore } from "./SharedStateStore.js";
export type { Action, Reducer, StateModel, StateSnapshot } from "./StateModel.js";
// #134 — StateModel contract
export { assertPure, defineStateModel, replayActions } from "./StateModel.js";
export type { StateToolsOpts } from "./stateTools.js";
// #137 — Agent tools
export { stateTools } from "./stateTools.js";
export type {
  CustomFrame,
  SseTransportOpts,
  StateDeltaFrame,
  StateTransport,
  TransportFrame,
} from "./transport.js";
// #136 — Transport adapters
export {
  bindStoreToTransport,
  messageChannelTransport,
  sseTransport,
} from "./transport.js";
export type { ZodStateModel, ZodStateModelOpts } from "./zodStateModel.js";
// #134 — Zod adapter
export { zodStateModel } from "./zodStateModel.js";
