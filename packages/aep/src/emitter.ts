import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import type { DSSEEnvelope } from "./dsse.js";
import { paeEncode, wrapInTotoStatement } from "./dsse.js";
import type { EvidenceStore } from "./evidenceStore.js";
import type { AEPSigner } from "./signer.js";
import type { AEPTimestamper } from "./timestamper.js";
import type {
  ActionEvidence,
  AEPRecord,
  BudgetLedger,
  CapabilityDecision,
  InputRef,
  OutputRef,
  RecordingMode,
  RunContext,
  SideEffectClass,
  VerifierResult,
} from "./types.js";
import { AEPRecordSchema } from "./types.js";

/**
 * Ordered severity of side-effect classes from least to most impactful.
 * Used to compute the run-level maximum.
 */
const SIDE_EFFECT_ORDER: readonly SideEffectClass[] = [
  "read",
  "mutate-local",
  "mutate-external",
  "network-egress",
  "unknown",
] as const;

function sideEffectOrdinal(cls: SideEffectClass): number {
  const idx = SIDE_EFFECT_ORDER.indexOf(cls);
  return idx === -1 ? SIDE_EFFECT_ORDER.length : idx;
}

export interface AEPEmitterOptions {
  run_id: string;
  user_id?: string;
  subject_id?: string;
  /** Target schema version for emitted records. Default: "aep/v0.4" (DSSE); set "aep/v0.5" for the current attribution-graded vocabulary. build() stamps "aep/v0.3" on unsigned records. */
  schemaVersion?: "aep/v0.3" | "aep/v0.4" | "aep/v0.5";
  /** v0.5: principal that granted/approved the authority (may differ from user_id). */
  authorized_by?: string;
  /** v0.5: how the principal's authority was obtained. */
  authority_origin?:
    | "subject_consented"
    | "administrator_assigned"
    | "organization_wide"
    | "unknown";
  /** v0.5: how the identity behind the backing key was established. */
  identity_source?:
    | "self_asserted"
    | "organization_attested"
    | "notified_eid"
    | "qualified_certificate"
    | "unknown";
  /** v0.5: what backs the human attribution. */
  attribution_backing?:
    | "operator_asserted"
    | "principal_key_signed"
    | "qualified_signature"
    | "unknown";
  /** v0.5: weakest backing present across the run — MUST NOT round up. */
  run_attribution_backing_floor?:
    | "operator_asserted"
    | "principal_key_signed"
    | "qualified_signature"
    | "unknown";
  /** v0.5: every backing grade observed across the run (floor and itemization ship together). */
  run_attribution_backing_observed?: Array<
    "operator_asserted" | "principal_key_signed" | "qualified_signature" | "unknown"
  >;
  /** v0.5: selective-omission defense — commits the producer to a specific evidence population. */
  authorization_evidence_count?: number;
  trace_id?: string;
  parent_trace_id?: string | null;
  repo_commit?: string;
  runtime_version?: string;
  model_provider?: string;
  model_id?: string;
  policy_bundle_digest?: string;
  tool_manifest_digest?: string;
  /** Default created_at_ms timestamp. Overridden by the parameter to build()/emit(). */
  created_at_ms?: number;
  /** Run context including session_id, turn_index, agent metadata. */
  run_context?: RunContext;
  /** Optional signer. When provided, emit() signs the record; build() remains unsigned-compatible via a dummy placeholder. */
  signer?: AEPSigner;
  /** Optional timestamper. When provided, emit() attaches a timestamp proof after signing. */
  timestamper?: AEPTimestamper;
  /** Default recording mode for actions added without an explicit recording_mode. */
  recordingMode?: RecordingMode;
  /** Default side_effect_class for actions added without an explicit side_effect_class. */
  sideEffectClass?: SideEffectClass;
  /** When true, emit() will not throw if no actions have been recorded. */
  allowEmptyActions?: boolean;
  /**
   * Optional evidence store. When provided, emit() automatically appends
   * the signed record to the store after signing and before returning.
   */
  evidenceStore?: EvidenceStore;
}

export class AEPEmitter {
  readonly #opts: AEPEmitterOptions;
  readonly #actions: ActionEvidence[] = [];
  readonly #capabilityDecisions: CapabilityDecision[] = [];
  readonly #inputRefs: InputRef[] = [];
  readonly #outputRefs: OutputRef[] = [];
  readonly #verifierResults: VerifierResult[] = [];
  #budgetLedger: BudgetLedger | undefined;
  #userId: string | undefined;
  #subjectId: string | undefined;
  #prevRecordHash: string | null = null;

  constructor(opts: AEPEmitterOptions) {
    this.#opts = opts;
    this.#userId = opts.user_id;
    this.#subjectId = opts.subject_id;
  }

  setUserId(userId: string): void {
    this.#userId = userId;
  }

  setSubjectId(subjectId: string): void {
    this.#subjectId = subjectId;
  }

  addAction(
    action: Omit<ActionEvidence, "action_id" | "timestamp_ms"> & {
      action_id?: string;
      timestamp_ms?: number;
    }
  ): void {
    const recording_mode = action.recording_mode ?? this.#opts.recordingMode ?? "validation";
    const side_effect_class = action.side_effect_class ?? this.#opts.sideEffectClass ?? "unknown";
    this.#actions.push({
      ...action,
      // Defaults applied AFTER the spread: an explicit `action_id: undefined`
      // (common when spreading partially-filled objects) must not clobber
      // them — the zod schema has no defaults here, so emit() would die on
      // validation instead of generating the id/timestamp.
      action_id: action.action_id ?? `action-${this.#actions.length}`,
      timestamp_ms: action.timestamp_ms ?? Date.now(),
      recording_mode,
      side_effect_class,
    } as ActionEvidence);
    if (action.capability_decision) {
      this.#pushCapabilityDecision(action.capability_decision);
    }
  }

  addCapabilityDecision(decision: CapabilityDecision): void {
    this.#pushCapabilityDecision(decision);
  }

  #pushCapabilityDecision(decision: CapabilityDecision): void {
    const exists = this.#capabilityDecisions.some(
      (d) =>
        d.capability === decision.capability &&
        d.subject === decision.subject &&
        d.resource === decision.resource
    );
    if (!exists) this.#capabilityDecisions.push(decision);
  }

  addInputRef(ref: InputRef): void {
    this.#inputRefs.push(ref);
  }

  addOutputRef(ref: OutputRef): void {
    this.#outputRefs.push(ref);
  }

  addVerifierResult(result: VerifierResult): void {
    this.#verifierResults.push(result);
  }

  setBudgetLedger(ledger: BudgetLedger): void {
    this.#budgetLedger = ledger;
  }

  /**
   * Build an unsigned AEPRecord. Canonical aep-record keeps `signature`
   * optional: an unsigned record is protocol-valid, and verifyAEPRecord
   * reports it as unsigned rather than schema-invalid. Use `emit()` for a
   * signed record, or `AEPSignedRecordSchema` where a signature is required.
   *
   * Historical note: this used to attach a deterministic
   * `sig: "UNSIGNED_PLACEHOLDER"` block because the runtime schema still
   * required `signature` — that disguised "not signed" as a
   * signature-shaped object and is no longer emitted.
   *
   * @param createdAtMs - Override creation timestamp (defaults to Date.now()).
   * @param signerOverride - Optional: provide a signer to sign inline (async variant).
   *   Prefer `emit()` for async signing.
   */
  build(createdAtMs?: number): AEPRecord {
    const unsigned = this.#buildUnsigned(createdAtMs);
    return AEPRecordSchema.parse(unsigned);
  }

  /**
   * Build and sign an AEPRecord — DSSE is the only signing profile.
   *
   * Sequence:
   * 1. Assemble the record payload (no signature field yet).
   * 2. Wrap it in an in-toto Statement inside a DSSE envelope.
   * 3. Sign the PAE encoding with the configured AEPSigner.
   * 4. Attach `dsse_envelope`, stamp schema_version (aep/v0.5 when targeted,
   *    otherwise aep/v0.4), and mirror the signature into the legacy
   *    `signature` field as compatibility metadata only.
   *
   * The historical legacy emission path (inline Ed25519 over raw canonical
   * bytes, schema stamped aep/v0.3) has been removed: new signed evidence is
   * always DSSE. Historical records remain readable through the verifier's
   * documented behaviour on non-DSSE records.
   *
   * @param createdAtMs - Override creation timestamp.
   * @throws If no signer was provided at construction time.
   */
  async emit(createdAtMs?: number): Promise<AEPRecord> {
    const signer = this.#opts.signer;
    if (!signer) {
      throw new Error(
        "AEPEmitter.emit() requires a signer. Pass `signer` in AEPEmitterOptions or use build() for unsigned records."
      );
    }
    if (this.#actions.length === 0 && !this.#opts.allowEmptyActions) {
      throw new Error(
        "AEPEmitter.emit() called with no actions recorded. " +
          "Call addAction() at least once before emitting, or pass { allowEmptyActions: true } to the constructor."
      );
    }
    const unsigned = this.#buildUnsigned(createdAtMs);

    // Parse through zod so that zod normalises the record (applies defaults,
    // strips unknown fields) before we compute canonical bytes.
    // verifyAEPRecord strips `signature` from the already-parsed record and
    // recomputes the same canonical bytes, so both sides are consistent.
    const normalised = AEPRecordSchema.parse(unsigned);
    const {
      signature: _placeholder,
      dsse_envelope: _dsseIgnore,
      ...normalisedUnsigned
    } = normalised;

    // DSSE/in-toto path — the only signing profile. Stamp the final
    // schema_version BEFORE building the statement so the signed predicate
    // covers every field the record carries — otherwise inline fields are
    // not cryptographically bound to the envelope and verifyAEPRecord could
    // accept tampered records.
    const stamped = AEPRecordSchema.parse({
      ...normalisedUnsigned,
      schema_version: this.#opts.schemaVersion === "aep/v0.5" ? "aep/v0.5" : "aep/v0.4",
    });
    const unsignedFinal = stamped;

    const bytes = canonicalBytes(unsignedFinal);
    const payloadDigest = createHash("sha256").update(bytes).digest("hex");

    // Wrap into in-toto Statement
    const statement = wrapInTotoStatement(
      unsignedFinal as unknown as Record<string, unknown>,
      unsignedFinal.run_id,
      payloadDigest
    );
    const statementJson = JSON.stringify(statement);
    const payloadB64 = Buffer.from(statementJson).toString("base64");

    // Compute PAE and sign
    const payloadType = "application/vnd.in-toto+json";
    const paeBytes = paeEncode(payloadType, payloadB64);
    const sig = await signer.sign(paeBytes);

    // Build DSSE envelope
    const dsseEnvelope: DSSEEnvelope = {
      payloadType,
      payload: payloadB64,
      signatures: [{ keyid: signer.keyId, sig }],
    };

    // Mirror the signature into the legacy `signature` field as
    // compatibility metadata only — the DSSE envelope is the authenticity
    // carrier; this field is not an independent signing contract.
    const signature: AEPRecord["signature"] = {
      alg: "ed25519",
      key_id: signer.keyId,
      sig,
    };

    const record = AEPRecordSchema.parse({
      ...unsignedFinal,
      dsse_envelope: dsseEnvelope,
      signature,
    });

    // If a timestamper is configured, request a timestamp proof and attach it
    const timestamper = this.#opts.timestamper;
    if (timestamper) {
      const tsBytes = canonicalBytes(unsignedFinal);
      const proof = await timestamper.timestamp(tsBytes);
      record.timestamp_proof = proof;
    }

    // Compute hash for chain linkage
    const { signature: _sig, dsse_envelope: _dsse, ...recordUnsigned } = record;
    const recordBytes = canonicalBytes(recordUnsigned);
    this.#prevRecordHash = createHash("sha256").update(recordBytes).digest("hex");

    // Stream to evidence store if configured
    if (this.#opts.evidenceStore) {
      await this.#opts.evidenceStore.append(record);
    }

    return record;
  }

  #computeRunSideEffectClassMax(): SideEffectClass | undefined {
    if (this.#actions.length === 0) return undefined;
    let maxOrdinal = -1;
    let maxClass: SideEffectClass = "read";
    for (const action of this.#actions) {
      const cls = (action.side_effect_class ?? "unknown") as SideEffectClass;
      const ord = sideEffectOrdinal(cls);
      if (ord > maxOrdinal) {
        maxOrdinal = ord;
        maxClass = cls;
      }
    }
    return maxClass;
  }

  #buildUnsigned(createdAtMs?: number): Omit<AEPRecord, "signature"> {
    const {
      signer: _signer,
      user_id: _u,
      subject_id: _s,
      created_at_ms: defaultTs,
      run_context,
      recordingMode: _rm,
      sideEffectClass: _sec,
      schemaVersion,
      authorized_by,
      authority_origin,
      identity_source,
      attribution_backing,
      run_attribution_backing_floor,
      run_attribution_backing_observed,
      ...opts
    } = this.#opts;
    const runSideEffectMax = this.#computeRunSideEffectClassMax();

    // aep/v0.5 floor consistency: the floor MUST be the weakest grade in
    // `run_attribution_backing_observed` (MUST NOT round up). The check runs
    // regardless of whether the observed set is empty — a floor without an
    // itemization is exactly the masking the floor exists to prevent.
    const backingOrder = [
      "unknown",
      "operator_asserted",
      "principal_key_signed",
      "qualified_signature",
    ] as const;
    const backingRank = (g: string): number => {
      const i = (backingOrder as readonly string[]).indexOf(g);
      return i === -1 ? backingOrder.length : i;
    };
    let floor = run_attribution_backing_floor;
    const observed = run_attribution_backing_observed;

    // FAIL CLOSED: a caller-supplied floor without a non-empty observed set
    // cannot be verified against the weakest-grade rule — reject it rather
    // than silently accepting an unverifiable claim.
    if (floor !== undefined && (!observed || observed.length === 0)) {
      throw new Error(
        `run_attribution_backing_floor "${floor}" was provided without a non-empty ` +
          `run_attribution_backing_observed set — the floor cannot be verified. ` +
          `Either provide a non-empty observed set or omit the floor.`
      );
    }

    if (observed !== undefined && observed.length > 0) {
      const weakest = observed.reduce((acc, g) => (backingRank(g) < backingRank(acc) ? g : acc));
      if (floor !== undefined && floor !== weakest) {
        throw new Error(
          `run_attribution_backing_floor "${floor}" is not the weakest observed grade "${weakest}" — the floor MUST NOT round up.`
        );
      }
      if (floor === undefined) floor = weakest;
    }

    return {
      schema_version: schemaVersion ?? "aep/v0.3",
      ...opts,
      ...(this.#userId !== undefined && { user_id: this.#userId }),
      ...(this.#subjectId !== undefined && { subject_id: this.#subjectId }),
      ...(authorized_by !== undefined && { authorized_by }),
      ...(authority_origin !== undefined && { authority_origin }),
      ...(identity_source !== undefined && { identity_source }),
      ...(attribution_backing !== undefined && { attribution_backing }),
      ...(floor !== undefined && { run_attribution_backing_floor: floor }),
      ...(observed !== undefined && {
        run_attribution_backing_observed: observed,
      }),
      input_refs: this.#inputRefs,
      output_refs: this.#outputRefs,
      capability_decisions: this.#capabilityDecisions,
      actions: this.#actions,
      verifier_results: this.#verifierResults,
      budget_ledger: this.#budgetLedger,
      created_at_ms: createdAtMs ?? defaultTs ?? Date.now(),
      prev_record_hash: this.#prevRecordHash,
      ...(run_context !== undefined && { run_context }),
      ...(runSideEffectMax !== undefined && {
        run_side_effect_class_max: runSideEffectMax,
      }),
    };
  }

  static digestContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  static withDefaults(defaults: Partial<AEPEmitterOptions>): {
    create(overrides?: Partial<AEPEmitterOptions>): AEPEmitter;
  } {
    return {
      create(overrides?: Partial<AEPEmitterOptions>) {
        return new AEPEmitter({ ...defaults, ...overrides } as AEPEmitterOptions);
      },
    };
  }
}
