/**
 * Routing presets for local + cloud composition (L5).
 *
 * These are thin wrappers over @wasmagent/core's existing FallbackModel —
 * we deliberately do NOT introduce a parallel routing mechanism. The presets
 * exist purely as named, documented combinations:
 *
 *   - `localFirst(local, cloud)` — try local first; fall through to cloud on
 *     failure. Good for "free dev/CI runs, paid prod-quality fallback".
 *   - `offlineOnly(local)` — single-model passthrough, but loud and explicit
 *     so reviewers see the offline boundary in the call site.
 *
 * Why not a single `local()` factory: explicitness in the routing wiring is
 * a recurring user-feedback theme. A reader of `new FallbackModel([a, b])`
 * has to look up the arguments; `localFirst(local, cloud)` cannot be misread.
 */

import { FallbackModel, type Model } from "@wasmagent/core/models";

/**
 * Try the local model first; on any error, fall through to the cloud model.
 *
 * Equivalent to `new FallbackModel([local, cloud])` — but the named factory
 * carries intent and gives `agentkit devtools` a stable label to surface in
 * trace overlays.
 */
export function localFirst(local: Model, cloud: Model): FallbackModel {
  return new FallbackModel([local, cloud]);
}

/**
 * Wrap a local model in an "offline only" envelope. Currently this is the
 * same model (passthrough) but the helper is the documented entry point for
 * "this code MUST NOT call out to a cloud provider" — so future versions
 * can layer on offline-only enforcement (e.g. a proxy that refuses if a
 * fallback is added) without breaking the call site.
 */
export function offlineOnly(local: Model): Model {
  return local;
}

/**
 * Convenience: read the AGENTKIT_DEV_LOCAL flag and pick the right model
 * for development workflows.
 *
 *   - `AGENTKIT_DEV_LOCAL=1` → return the local model (zero API cost in CI).
 *   - otherwise              → return the cloud model.
 *
 * Use in test setups so the same code path runs on a developer laptop with
 * a tiny GGUF and on CI with a paid endpoint.
 */
export function devLocalOr(local: Model, cloud: Model): Model {
  return process.env.AGENTKIT_DEV_LOCAL === "1" ? local : cloud;
}
