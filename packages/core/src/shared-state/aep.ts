/**
 * #141 — AEP Confluence: semantic action stream as evidence log.
 *
 * Opt-in sink that turns a {@link SharedStateStore}'s semantic action stream
 * into AEP evidence. Because actions are semantic and the reducer is pure, the
 * entire state is replayable from the action stream (`replayActions`) — so the
 * same stream that syncs the UI also serves as the provenance / audit log.
 * **The UI sync stream and the evidence stream become the same stream.**
 *
 * ## Dependency boundary
 *
 * This dedicated subpath (`@wasmagent/core/shared-state/aep`) is the ONLY file
 * in `shared-state` that references `@wasmagent/aep`, and it does so exclusively
 * via `import type`. The compiled output therefore carries **zero runtime
 * dependency** on the evidence layer, keeping the base store dependency-free
 * and tree-shakable. The base barrel (`./index.js`) MUST NOT re-export from
 * here — that isolation is enforced by a dependency test in `aep.test.ts`.
 *
 * The {@link AEPEmitter} instance is supplied by the caller, who owns
 * signing/building; this sink only feeds actions in.
 */

import type { ActionEvidence, AEPEmitter, RecordingMode, SideEffectClass } from "@wasmagent/aep";

import type { ChangeEvent, SharedStateStore } from "./SharedStateStore.js";
import type { Action } from "./StateModel.js";

/** Options for {@link aepEvidenceSink}. */
export interface AepEvidenceSinkOpts<S, A extends Action> {
  /**
   * Predicate selecting which state changes to record as evidence.
   *
   * Default: **agent-sourced writes only** (`evt.source === "agent"`). This
   * ensures human edits are not misattributed to the agent — only actions the
   * agent authored enter the evidence stream.
   */
  include?: (action: A, evt: ChangeEvent<S>) => boolean;

  /**
   * Maps a semantic action to its AEP `side_effect_class`.
   *
   * Default: `"mutate-local"` — reducer mutations are local state changes.
   * Override to classify per-action (e.g. flag `network-egress` tools).
   */
  sideEffectClass?: (action: A) => SideEffectClass;

  /**
   * Maps a semantic action to its AEP `recording_mode`.
   *
   * Default: `"delta"` — capture the state delta, which fits the UI sync
   * stream. Override to mirror a per-tool `full`/`delta`/`validation` policy.
   */
  recordingMode?: (action: A) => RecordingMode;
}

/**
 * Attach an AEP evidence sink to a {@link SharedStateStore}.
 *
 * Subscribes to the store (all sessions); for each qualifying change, records
 * the semantic action as AEP evidence on the provided `emitter` via
 * `emitter.addAction(...)`, marking it `state_changing: true` and classifying
 * it with the mapped `side_effect_class` and `recording_mode`.
 *
 * `replace()` calls produce no semantic action (no reducer dispatch) and are
 * skipped — only reducer-dispatched actions enter the evidence stream, which is
 * what makes the stream replayable.
 *
 * @returns A detach function that stops recording.
 *
 * @example
 * ```ts
 * import { AEPEmitter } from "@wasmagent/aep";
 * import { SharedStateStore } from "@wasmagent/core/shared-state";
 * import { aepEvidenceSink } from "@wasmagent/core/shared-state/aep";
 *
 * const detach = aepEvidenceSink(store, emitter, {
 *   sideEffectClass: (a) => (a.type === "send_email" ? "network-egress" : "mutate-local"),
 * });
 * // ...later
 * detach();
 * ```
 */
export function aepEvidenceSink<S, A extends Action>(
  store: SharedStateStore<S, A>,
  emitter: AEPEmitter,
  opts?: AepEvidenceSinkOpts<S, A>
): () => void {
  const include = opts?.include ?? ((_action: A, evt: ChangeEvent<S>) => evt.source === "agent");
  const sideEffectClass =
    opts?.sideEffectClass ?? ((_action: A): SideEffectClass => "mutate-local");
  const recordingMode = opts?.recordingMode ?? ((_action: A): RecordingMode => "delta");

  return store.subscribeToAll((evt) => {
    // `replace()` notifies with no action — there is no semantic action to
    // record, and it is not part of the replayable stream.
    if (evt.action === undefined) return;

    const action = evt.action as A;
    if (!include(action, evt)) return;

    const evidence: Omit<ActionEvidence, "action_id" | "timestamp_ms"> = {
      tool_name: action.type,
      state_changing: true,
      evidence_refs: [],
      side_effect_class: sideEffectClass(action),
      recording_mode: recordingMode(action),
    };
    emitter.addAction(evidence);
  });
}
