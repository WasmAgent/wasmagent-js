/**
 * PosturePolicy — cross-agent policy inheritance + delegation (Milestone 6).
 *
 * A "posture" is the security control set an agent operates under: which hosts
 * it may contact, which filesystem paths it may read/write, which extra
 * capabilities it holds, which tools are explicitly denied, how much evidence
 * is recorded, and its CPU budget. When a parent agent spawns a sub-agent, the
 * parent's posture MUST cascade down — a sub-agent must never hold a broader
 * posture than its parent. This is the capability-attenuation principle: a
 * delegation can only ever shrink privilege.
 *
 * The cascade is enforced by {@link inheritPosture}, which merges a parent
 * posture with an optional child override under a strict monotonic-narrowing
 * rule:
 *
 *   - allow-lists (hosts, read paths, write paths, capabilities): the child's
 *     effective allow-list is the INTERSECTION of parent and child. Anything
 *     the child requests that the parent did not grant is dropped (attenuated).
 *   - deny-list (denied tools): the child's effective deny-list is the UNION of
 *     parent and child — denial only ever grows.
 *   - recording mode: the child's effective mode is the MAX of parent and child
 *     by severity (validation < delta < full). A sub-agent may record MORE, never less.
 *   - cpu budget: the child's effective ceiling is the MIN of parent and child
 *     (a sub-agent may only shrink its own deadline).
 *
 * Each inheritance is captured as a {@link PostureDelegationRecord} carrying
 * the parent posture, the effective child posture, the list of attenuations
 * (every field where the child asked for more than the parent allowed), and a
 * SHA-256 digest binding the two postures. Appended to an evidence store, this
 * gives auditors a tamper-evident trail of every posture delegation — the
 * "evidence tracking" half of the milestone bullet.
 *
 * ## Dependency boundary
 *
 * Posture allow-lists are structurally aligned with {@link CapabilityManifest}
 * (same field names) so a manifest lifts into a posture via
 * {@link postureFromManifest} and an effective posture projects back into a
 * manifest via {@link manifestFromPosture} for kernel enforcement. Hashing
 * uses only `node:crypto`, so this module carries no external runtime deps —
 * the same structural-store boundary `AgentGroup` uses.
 */

import { createHash } from "node:crypto";
import type { CapabilityManifest } from "../executor/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Evidence-recording severity. Higher rank = more captured. */
export type PostureRecordingMode = "validation" | "delta" | "full";

/**
 * The security posture an agent (or group/team) operates under.
 *
 * Field names mirror {@link CapabilityManifest} so the two convert losslessly
 * via {@link postureFromManifest} / {@link manifestFromPosture}.
 */
export interface PosturePolicy {
  /** Hostnames the agent may contact. Sub-agent posture ⊆ parent. */
  allowedHosts: string[];
  /** Filesystem read path prefixes. Sub-agent posture ⊆ parent. */
  allowedReadPaths: string[];
  /** Filesystem write path prefixes. Sub-agent posture ⊆ parent. */
  allowedWritePaths: string[];
  /** Named capabilities (e.g. "tool:web_search"). Sub-agent ⊆ parent. */
  extraCapabilities: string[];
  /** Tools explicitly blocked. Sub-agent deny-list ⊇ parent (only grows). */
  deniedTools: string[];
  /** Evidence-recording severity floor. Sub-agent ≥ parent (elevation only). */
  recordingMode: PostureRecordingMode;
  /** Per-call CPU ceiling (ms). Sub-agent ≤ parent (shrink only). Optional. */
  cpuMs?: number;
}

/**
 * A partial posture a child requests when spawned. Every field is optional;
 * omitted fields inherit the parent's value unchanged. Provided allow-lists are
 * intersected with the parent's (narrowing), never widened.
 */
export type PostureOverride = Partial<
  Pick<
    PosturePolicy,
    | "allowedHosts"
    | "allowedReadPaths"
    | "allowedWritePaths"
    | "extraCapabilities"
    | "deniedTools"
    | "recordingMode"
    | "cpuMs"
  >
>;

/** Which posture field an {@link PostureAttenuation} clamped. */
export type PostureField =
  | "allowedHosts"
  | "allowedReadPaths"
  | "allowedWritePaths"
  | "extraCapabilities"
  | "deniedTools"
  | "recordingMode"
  | "cpuMs";

/**
 * One place where the child requested MORE than the parent granted, and was
 * attenuated down. Surfacing these in the evidence trail turns a privilege-
 * escalation attempt into an auditable, hash-bound signal.
 */
export interface PostureAttenuation {
  field: PostureField;
  /** What the child requested for this field (omitted fields are not listed). */
  requested: string[] | PostureRecordingMode | number;
  /** What the child actually received (≤ parent). */
  granted: string[] | PostureRecordingMode | number;
  /** Why the value was reduced. */
  reason: string;
}

/** Result of {@link inheritPosture}: the effective child posture + audit trail. */
export interface PostureInheritance {
  /** The narrowed posture the child actually runs under. */
  effective: PosturePolicy;
  /** Every field where the child asked for more than the parent allowed. */
  attenuations: PostureAttenuation[];
}

/** Discriminator for {@link PostureDelegationRecord}. */
export const POSTURE_DELEGATION_TYPE = "aep-posture-delegation/v0.1";

/**
 * Evidence record binding a parent's posture to the effective posture a spawned
 * sub-agent runs under. Append it to an evidence store (e.g.
 * `@wasmagent/aep`'s `EvidenceStore`) to place the delegation into the durable
 * chain. The {@link postureDigest} makes any change to the parent or effective
 * posture (or the agents involved) detectable on recompute.
 */
export interface PostureDelegationRecord {
  type: typeof POSTURE_DELEGATION_TYPE;
  /** The delegating (parent) agent id. */
  parentAgentId: string;
  /** The spawned (child) agent id. */
  childAgentId: string;
  /** AEP delegation chain (parent → ... → child). */
  delegationChain: string[];
  /** The parent's posture. */
  parentPosture: PosturePolicy;
  /** What the child requested (omitted fields inherit the parent). */
  childOverride: PostureOverride;
  /** The effective posture the child runs under (post-narrowing). */
  effectivePosture: PosturePolicy;
  /** Fields where the child was attenuated down (escalation attempts). */
  attenuations: PostureAttenuation[];
  created_at_ms: number;
  /**
   * SHA-256 over the canonical serialization of
   * `{ parentAgentId, childAgentId, parentPosture, effectivePosture }`.
   * Recompute with {@link postureDigestFor}. Binds the delegation so any change
   * to either posture — or to the agents involved — is detectable.
   */
  postureDigest: string;
}

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Merge a parent posture with an optional child override under the
 * monotonic-narrowing rule. Returns the effective (narrowed) child posture plus
 * the list of attenuations (escalation attempts that were clamped down).
 *
 * @param parent   - The posture the child inherits from.
 * @param override - The narrowing the child requests (optional fields inherit parent).
 * @returns The effective child posture + the audit trail of clamped fields.
 */
export function inheritPosture(
  parent: PosturePolicy,
  override: PostureOverride = {}
): PostureInheritance {
  const attenuations: PostureAttenuation[] = [];

  const allowedHosts = intersectAllow(parent.allowedHosts, override.allowedHosts);
  pushListAttenuation(
    attenuations,
    "allowedHosts",
    parent.allowedHosts,
    override.allowedHosts,
    allowedHosts
  );

  const allowedReadPaths = intersectAllow(parent.allowedReadPaths, override.allowedReadPaths);
  pushListAttenuation(
    attenuations,
    "allowedReadPaths",
    parent.allowedReadPaths,
    override.allowedReadPaths,
    allowedReadPaths
  );

  const allowedWritePaths = intersectAllow(parent.allowedWritePaths, override.allowedWritePaths);
  pushListAttenuation(
    attenuations,
    "allowedWritePaths",
    parent.allowedWritePaths,
    override.allowedWritePaths,
    allowedWritePaths
  );

  const extraCapabilities = intersectAllow(parent.extraCapabilities, override.extraCapabilities);
  pushListAttenuation(
    attenuations,
    "extraCapabilities",
    parent.extraCapabilities,
    override.extraCapabilities,
    extraCapabilities
  );

  // deny-list only ever grows: union (deduped, parent order preserved).
  const deniedTools = unionDeny(parent.deniedTools, override.deniedTools);

  // recording: elevate to the stricter (higher-rank) of parent and override.
  const requestedRecording = override.recordingMode;
  const effectiveRecording = maxRecording(parent.recordingMode, requestedRecording);
  if (
    requestedRecording !== undefined &&
    recordingRank(requestedRecording) < recordingRank(parent.recordingMode)
  ) {
    attenuations.push({
      field: "recordingMode",
      requested: requestedRecording,
      granted: effectiveRecording,
      reason: `requested recording mode "${requestedRecording}" is below parent floor "${parent.recordingMode}"; elevated`,
    });
  }

  // cpuMs: shrink to the smaller ceiling (child may add a budget the parent
  // lacked, but may not exceed a budget the parent set).
  const requestedCpu = override.cpuMs;
  const { cpuMs, clamped } = minBudget(parent.cpuMs, requestedCpu);
  if (clamped) {
    attenuations.push({
      field: "cpuMs",
      requested: requestedCpu as number,
      granted: cpuMs as number,
      reason: `requested cpuMs ${requestedCpu} exceeds parent ceiling ${parent.cpuMs}; clamped`,
    });
  }

  const effective: PosturePolicy = {
    allowedHosts,
    allowedReadPaths,
    allowedWritePaths,
    extraCapabilities,
    deniedTools,
    recordingMode: effectiveRecording,
  };
  if (cpuMs !== undefined) effective.cpuMs = cpuMs;

  return { effective, attenuations };
}

/**
 * Build a {@link PostureDelegationRecord} for one parent→child spawn. Computes
 * the effective posture via {@link inheritPosture} and binds it with a digest.
 * Append the result to an evidence store to record the delegation.
 */
export function buildPostureDelegationRecord(input: {
  parentAgentId: string;
  childAgentId: string;
  delegationChain: string[];
  parentPosture: PosturePolicy;
  childOverride?: PostureOverride;
}): PostureDelegationRecord {
  const { effective, attenuations } = inheritPosture(
    input.parentPosture,
    input.childOverride ?? {}
  );
  return {
    type: POSTURE_DELEGATION_TYPE,
    parentAgentId: input.parentAgentId,
    childAgentId: input.childAgentId,
    delegationChain: [...input.delegationChain],
    parentPosture: clonePosture(input.parentPosture),
    childOverride: cloneOverride(input.childOverride ?? {}),
    effectivePosture: effective,
    attenuations,
    created_at_ms: Date.now(),
    postureDigest: postureDigestFor({
      parentAgentId: input.parentAgentId,
      childAgentId: input.childAgentId,
      parentPosture: input.parentPosture,
      effectivePosture: effective,
    }),
  };
}

/**
 * Recompute the posture delegation digest — the tamper-evident bind over a
 * parent→child delegation. Canonical form is sorted-key, sorted-array-element
 * JSON of `{ parentAgentId, childAgentId, parentPosture, effectivePosture }`.
 * Auditors call this to verify a record: recompute from the record's own fields
 * and compare to `record.postureDigest`.
 */
export function postureDigestFor(input: {
  parentAgentId: string;
  childAgentId: string;
  parentPosture: PosturePolicy;
  effectivePosture: PosturePolicy;
}): string {
  const canon = JSON.stringify({
    childAgentId: input.childAgentId,
    effectivePosture: canonicalize(input.effectivePosture),
    parentAgentId: input.parentAgentId,
    parentPosture: canonicalize(input.parentPosture),
  });
  return sha256Hex(canon);
}

// ── Manifest bridges ─────────────────────────────────────────────────────────

/**
 * Lift a {@link CapabilityManifest} into a {@link PosturePolicy} — the usual
 * way to create the root posture an agent runs under. `recordingMode` defaults
 * to `"validation"` (minimal) so the caller opts INTO heavier recording; the
 * deny-list starts empty unless supplied.
 */
export function postureFromManifest(
  manifest: CapabilityManifest,
  opts: { recordingMode?: PostureRecordingMode; deniedTools?: string[] } = {}
): PosturePolicy {
  const posture: PosturePolicy = {
    allowedHosts: [...manifest.allowedHosts],
    allowedReadPaths: [...manifest.allowedReadPaths],
    allowedWritePaths: [...manifest.allowedWritePaths],
    extraCapabilities: [...manifest.extraCapabilities],
    deniedTools: opts.deniedTools ? [...opts.deniedTools] : [],
    recordingMode: opts.recordingMode ?? "validation",
  };
  if (manifest.cpuMs !== undefined) posture.cpuMs = manifest.cpuMs;
  return posture;
}

/**
 * Project an effective posture back into a {@link CapabilityManifest} for kernel
 * enforcement — e.g. pass the narrowed sub-agent posture to a WASM kernel's
 * capability surface. The deny-list and recording mode are posture-only (not
 * manifest fields) and are dropped here; enforce them at the tool surface.
 */
export function manifestFromPosture(posture: PosturePolicy): CapabilityManifest {
  const manifest: CapabilityManifest = {
    allowedHosts: [...posture.allowedHosts],
    allowedReadPaths: [...posture.allowedReadPaths],
    allowedWritePaths: [...posture.allowedWritePaths],
    extraCapabilities: [...posture.extraCapabilities],
  };
  if (posture.cpuMs !== undefined) manifest.cpuMs = posture.cpuMs;
  return manifest;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Severity rank of a recording mode (validation < delta < full). */
function recordingRank(mode: PostureRecordingMode): number {
  switch (mode) {
    case "validation":
      return 0;
    case "delta":
      return 1;
    case "full":
      return 2;
  }
}

/** The stricter (higher-rank) of two recording modes; undefined override = parent. */
function maxRecording(
  parent: PostureRecordingMode,
  override: PostureRecordingMode | undefined
): PostureRecordingMode {
  if (override === undefined) return parent;
  return recordingRank(override) >= recordingRank(parent) ? override : parent;
}

/**
 * Effective allow-list = parent ∩ override. An undefined override inherits the
 * parent's list verbatim (child declines to narrow this field). Order follows
 * the override's order so a child that lists `[b, a]` keeps that precedence;
 * duplicates are collapsed.
 */
function intersectAllow(parentList: string[], override: string[] | undefined): string[] {
  if (override === undefined) return [...parentList];
  const parent = new Set(parentList);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of override) {
    if (parent.has(item) && !seen.has(item)) {
      out.push(item);
      seen.add(item);
    }
  }
  return out;
}

/** Effective deny-list = parent ∪ override (deduped; parent order first). */
function unionDeny(parentList: string[], override: string[] | undefined): string[] {
  const out = [...parentList];
  const seen = new Set(parentList);
  for (const item of override ?? []) {
    if (!seen.has(item)) {
      out.push(item);
      seen.add(item);
    }
  }
  return out;
}

/** Items the child requested that the parent did NOT grant (the escalation attempt). */
function droppedItems(parentList: string[], override: string[] | undefined): string[] {
  if (override === undefined) return [];
  const parent = new Set(parentList);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of override) {
    if (!parent.has(item) && !seen.has(item)) {
      out.push(item);
      seen.add(item);
    }
  }
  return out;
}

/** Record an attenuation when the child requested allow-list items the parent lacks. */
function pushListAttenuation(
  attenuations: PostureAttenuation[],
  field: PostureField,
  parentList: string[],
  requested: string[] | undefined,
  granted: string[]
): void {
  const dropped = droppedItems(parentList, requested);
  if (dropped.length === 0) return;
  attenuations.push({
    field,
    requested: requested ?? [],
    granted,
    reason: `requested ${dropped.length} item(s) not granted by parent: ${dropped.join(", ")}`,
  });
}

/** Effective budget = min(parent, override). Returns the value + whether it was clamped. */
function minBudget(
  parent: number | undefined,
  override: number | undefined
): { cpuMs: number | undefined; clamped: boolean } {
  if (parent !== undefined && override !== undefined) {
    return { cpuMs: Math.min(parent, override), clamped: override > parent };
  }
  return { cpuMs: parent ?? override, clamped: false };
}

/** Defensive copy so callers can't mutate the recorded posture after the fact. */
function clonePosture(p: PosturePolicy): PosturePolicy {
  const out: PosturePolicy = {
    allowedHosts: [...p.allowedHosts],
    allowedReadPaths: [...p.allowedReadPaths],
    allowedWritePaths: [...p.allowedWritePaths],
    extraCapabilities: [...p.extraCapabilities],
    deniedTools: [...p.deniedTools],
    recordingMode: p.recordingMode,
  };
  if (p.cpuMs !== undefined) out.cpuMs = p.cpuMs;
  return out;
}

/** Defensive copy of an override (only the keys that are present). */
function cloneOverride(o: PostureOverride): PostureOverride {
  const out: PostureOverride = {};
  if (o.allowedHosts !== undefined) out.allowedHosts = [...o.allowedHosts];
  if (o.allowedReadPaths !== undefined) out.allowedReadPaths = [...o.allowedReadPaths];
  if (o.allowedWritePaths !== undefined) out.allowedWritePaths = [...o.allowedWritePaths];
  if (o.extraCapabilities !== undefined) out.extraCapabilities = [...o.extraCapabilities];
  if (o.deniedTools !== undefined) out.deniedTools = [...o.deniedTools];
  if (o.recordingMode !== undefined) out.recordingMode = o.recordingMode;
  if (o.cpuMs !== undefined) out.cpuMs = o.cpuMs;
  return out;
}

/** Deterministic value for hashing: sorted keys + sorted string-array elements. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);
    if (mapped.every((v) => typeof v === "string")) {
      return [...(mapped as string[])].sort();
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
