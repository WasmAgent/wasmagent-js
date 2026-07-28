import type { RemoteEvidenceBackend } from "./evidenceMirror.js";
import { contentDigestKeyOf } from "./evidenceMirror.js";
import type { EvidenceStore, EvidenceStoreQuery } from "./evidenceStore.js";
import { matchesFilter } from "./evidenceStore.js";
import type { AEPRecord, SideEffectClass } from "./types.js";

/**
 * evidenceRouter.ts — intelligent per-record routing for AEP evidence (Milestone 6).
 *
 * An {@link EvidenceRouter} takes each emitted {@link AEPRecord} and fans it out
 * to the right combination of (a) local stores, (b) remote backends, and
 * (c) subscribed auditors, applying two independent selection gates along the
 * way: **archival tier** and **content filter**. It is the single routing seam
 * called out by Milestone 6:
 *
 * > Implement `EvidenceRouter` for intelligent record routing — local vs remote
 * > storage, archival tiers, and selective broadcast to subscribed auditors.
 *
 * ## The three routing concerns
 *
 * | Concern | Mechanism |
 * |---------|-----------|
 * | local vs remote storage | sink `kind: "local" \| "remote"` |
 * | archival tiers | {@link EvidenceSink.tiers} + {@link EvidenceRouterOptions.classifyTier} |
 * | selective auditor broadcast | {@link EvidenceRouter.subscribe} with an optional filter |
 *
 * Storage sinks (local + remote) are configured up-front; auditors subscribe
 * dynamically, pub/sub-style, each with its own optional content filter.
 *
 * ## Routing decision (per sink, per record)
 *
 * For each configured sink the router asks, in order:
 *   1. **Tier gate** — if the sink declares `tiers` and the record's classified
 *      tier is not in that list (or the classifier returned `undefined`), the
 *      sink is skipped (`tier-excluded`).
 *   2. **Filter gate** — if the sink declares a `filter` and the record does not
 *      match it, the sink is skipped (`filter-excluded`).
 *   3. **Deliver** — append to the local store, or `put` to the remote backend
 *      under the configured content key.
 *
 * Subscribed auditors are then broadcast the record when their filter matches
 * (or they have no filter). A throw from any one sink or auditor is captured
 * into `result.errors` and never aborts the rest of the fan-out — evidence
 * routing is fail-soft so one bad sink cannot create a gap in the audit trail.
 *
 * Remote delivery is **idempotent** for the default content-digest key: routing
 * the same record twice `put`s identical bytes under the same key.
 */

/** Archival tier assigned to a record by the tier classifier. */
export type StorageTier = "hot" | "warm" | "cold";

/**
 * Classify a record into an archival tier, or `undefined` if it should not
 * match any tier-restricted sink. Defaults to {@link defaultTierClassifier}.
 */
export type TierClassifier = (record: AEPRecord) => StorageTier | undefined;

/** A storage destination: either a local {@link EvidenceStore} or a remote backend. */
export type EvidenceSink = LocalEvidenceSink | RemoteEvidenceSink;

interface SinkBase {
  /** Unique sink identifier (referenced in {@link SinkDelivery} and routing errors). */
  readonly id: string;
  /**
   * Restrict this sink to records classified into one of these tiers. Omit (or
   * pass an empty array) to accept every tier, including records the classifier
   * leaves unclassified (`undefined`).
   */
  readonly tiers?: readonly StorageTier[];
  /**
   * Only records matching this filter are delivered. Omit to deliver all
   * records (subject to the tier gate). Filters reuse the
   * {@link EvidenceStoreQuery} shape so routing predicates are interchangeable
   * with store queries.
   */
  readonly filter?: EvidenceStoreQuery;
}

/** A sink that appends matching records to a local {@link EvidenceStore}. */
export interface LocalEvidenceSink extends SinkBase {
  readonly kind: "local";
  readonly store: EvidenceStore;
}

/** A sink that `put`s matching records to a content-addressable remote backend. */
export interface RemoteEvidenceSink extends SinkBase {
  readonly kind: "remote";
  readonly remote: RemoteEvidenceBackend;
  /** Content key for the remote `put`. Defaults to {@link contentDigestKeyOf}. */
  readonly keyOf?: (record: AEPRecord) => string;
}

/**
 * Per-record callback for a subscribed auditor. Invoked once for every record
 * that passes the subscription's filter, along with the tier the router
 * classified it into. May be async; rejects are isolated into `result.errors`.
 */
export type AuditorCallback = (
  record: AEPRecord,
  tier: StorageTier | undefined
) => void | Promise<void>;

/**
 * Opaque handle for an auditor subscription; pass it (or its `id`) to
 * {@link EvidenceRouter.unsubscribe}.
 */
export interface AuditorSubscription {
  /** Subscription id (also the auditor's identity in routing errors). */
  readonly id: string;
  /** The filter this subscription was created with. */
  readonly filter?: EvidenceStoreQuery;
}

/** Outcome of one sink for one routed record. */
export interface SinkDelivery {
  readonly sinkId: string;
  readonly kind: "local" | "remote";
  readonly status: "delivered" | "tier-excluded" | "filter-excluded";
}

/** A capture of a sink/auditor failure during routing (never aborts the fan-out). */
export interface RoutingError {
  readonly target: string;
  readonly kind: "local" | "remote" | "auditor";
  readonly error: unknown;
}

/** Result of {@link EvidenceRouter.route}. */
export interface RoutingResult {
  /** The tier the classifier assigned to this record (`undefined` if unclassified). */
  readonly tier: StorageTier | undefined;
  /** Number of sinks that successfully received the record. */
  readonly deliveredToSinks: number;
  /** Number of subscribed auditors that successfully received the record. */
  readonly deliveredToAuditors: number;
  /** Per-sink outcome, in sink configuration order. */
  readonly sinks: SinkDelivery[];
  /** Failures captured during the fan-out (never aborts routing). */
  readonly errors: RoutingError[];
}

/** Options for constructing an {@link EvidenceRouter}. */
export interface EvidenceRouterOptions {
  /** Storage sinks (local + remote) to fan records out to. Defaults to none. */
  readonly sinks?: readonly EvidenceSink[];
  /** Tier classifier override. Defaults to {@link defaultTierClassifier}. */
  readonly classifyTier?: TierClassifier;
}

/**
 * Mapping from a run's maximum side-effect class to an archival tier, used by
 * {@link defaultTierClassifier}. External/mutating/unknown-impact evidence
 * stays on the hot tier; pure reads archive to cold.
 */
const SEVERITY_TIER: Readonly<Record<SideEffectClass, StorageTier>> = {
  read: "cold",
  "mutate-local": "warm",
  "mutate-external": "hot",
  "network-egress": "hot",
  unknown: "hot",
};

/**
 * Default tier classifier: maps the run-level maximum side-effect class to an
 * archival tier.
 *
 * | `run_side_effect_class_max` | tier |
 * |---|---|
 * | `network-egress`, `mutate-external`, `unknown` | `hot` |
 * | `mutate-local` | `warm` |
 * | `read`, or absent (no side-effect information) | `cold` |
 *
 * Explicitly `unknown` evidence lands on `hot` so un-characterised risk stays
 * immediately auditable; records with no side-effect information at all (e.g.
 * legacy records or records with no actions) classify as `cold`.
 */
export function defaultTierClassifier(record: AEPRecord): StorageTier {
  const max = record.run_side_effect_class_max;
  if (max === undefined) return "cold";
  return SEVERITY_TIER[max] ?? "hot";
}

function tierAccepted(sink: EvidenceSink, tier: StorageTier | undefined): boolean {
  // No `tiers` (or an empty list) means the sink accepts everything, including
  // records the classifier left unclassified.
  if (sink.tiers === undefined || sink.tiers.length === 0) return true;
  if (tier === undefined) return false;
  return sink.tiers.includes(tier);
}

async function deliverToSink(sink: EvidenceSink, record: AEPRecord): Promise<void> {
  if (sink.kind === "local") {
    await sink.store.append(record);
    return;
  }
  const key = (sink.keyOf ?? contentDigestKeyOf)(record);
  await sink.remote.put(key, record);
}

/**
 * EvidenceRouter — intelligent fan-out of AEP records to local stores, remote
 * backends, and subscribed auditors.
 *
 * Storage sinks (local + remote) are supplied at construction; auditors attach
 * dynamically via {@link subscribe}. Each record is classified into an archival
 * tier, then delivered to every sink whose tier and filter gates it passes,
 * and broadcast to every auditor whose filter matches.
 *
 * @example
 * ```ts
 * import {
 *   EvidenceRouter,
 *   InMemoryEvidenceStore,
 *   InMemoryRemoteEvidenceBackend,
 * } from "@wasmagent/aep";
 *
 * const hotStore = new InMemoryEvidenceStore();
 * const archive = new InMemoryRemoteEvidenceBackend("s3");
 * const router = new EvidenceRouter({
 *   sinks: [
 *     { kind: "local", id: "hot-local", store: hotStore, tiers: ["hot"] },
 *     { kind: "remote", id: "cold-archive", remote: archive, tiers: ["cold"] },
 *   ],
 * });
 *
 * router.subscribe(
 *   (record) => console.log("auditor saw", record.run_id),
 *   { action_type: "network-egress" },
 * );
 *
 * const result = await router.route(record);
 * console.log(`tier=${result.tier} sinks=${result.deliveredToSinks}`);
 * ```
 */
export class EvidenceRouter {
  readonly #sinks: ReadonlyArray<EvidenceSink>;
  readonly #classify: TierClassifier;
  readonly #auditors = new Map<
    string,
    { filter?: EvidenceStoreQuery; callback: AuditorCallback }
  >();
  #nextAuditorId = 0;

  constructor(options: EvidenceRouterOptions = {}) {
    this.#sinks = options.sinks ? [...options.sinks] : [];
    const ids = new Set<string>();
    for (const sink of this.#sinks) {
      if (ids.has(sink.id)) {
        throw new Error(`EvidenceRouter sink id "${sink.id}" is not unique`);
      }
      ids.add(sink.id);
    }
    this.#classify = options.classifyTier ?? defaultTierClassifier;
  }

  /** Number of configured storage sinks. */
  get sinkCount(): number {
    return this.#sinks.length;
  }

  /** Number of currently subscribed auditors. */
  get auditorCount(): number {
    return this.#auditors.size;
  }

  /**
   * Subscribe an auditor callback. The auditor receives every record whose
   * content matches `filter` (or every record if no filter is given), along
   * with the tier the router classified it into. Returns an opaque handle for
   * later {@link unsubscribe}.
   */
  subscribe(callback: AuditorCallback, filter?: EvidenceStoreQuery): AuditorSubscription {
    const id = `auditor-${this.#nextAuditorId++}`;
    // Build the entry conditionally so we never materialise an explicit
    // `filter: undefined` key (rejected under `exactOptionalPropertyTypes`).
    this.#auditors.set(id, filter === undefined ? { callback } : { callback, filter });
    return filter === undefined ? { id } : { id, filter };
  }

  /** Cancel a subscription. Returns `true` if a subscription was removed. */
  unsubscribe(subscription: AuditorSubscription | string): boolean {
    const id = typeof subscription === "string" ? subscription : subscription.id;
    return this.#auditors.delete(id);
  }

  /**
   * Route a single record: classify its tier, fan out to every sink that passes
   * the tier + filter gates, then broadcast to every matching auditor. Per-target
   * errors are captured into `result.errors` and never abort the fan-out.
   */
  async route(record: AEPRecord): Promise<RoutingResult> {
    const tier = this.#classify(record);
    const sinks: SinkDelivery[] = [];
    const errors: RoutingError[] = [];
    let deliveredToSinks = 0;

    for (const sink of this.#sinks) {
      if (!tierAccepted(sink, tier)) {
        sinks.push({ sinkId: sink.id, kind: sink.kind, status: "tier-excluded" });
        continue;
      }
      if (sink.filter !== undefined && !matchesFilter(record, sink.filter)) {
        sinks.push({ sinkId: sink.id, kind: sink.kind, status: "filter-excluded" });
        continue;
      }
      try {
        await deliverToSink(sink, record);
        sinks.push({ sinkId: sink.id, kind: sink.kind, status: "delivered" });
        deliveredToSinks++;
      } catch (err) {
        errors.push({ target: sink.id, kind: sink.kind, error: err });
      }
    }

    let deliveredToAuditors = 0;
    for (const [id, sub] of this.#auditors) {
      if (sub.filter !== undefined && !matchesFilter(record, sub.filter)) continue;
      try {
        await sub.callback(record, tier);
        deliveredToAuditors++;
      } catch (err) {
        errors.push({ target: id, kind: "auditor", error: err });
      }
    }

    return { tier, deliveredToSinks, deliveredToAuditors, sinks, errors };
  }
}
