import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import type { AEPSigner } from "./signer.js";
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
  /** Default recording mode for actions added without an explicit recording_mode. */
  recordingMode?: RecordingMode;
  /** Default side_effect_class for actions added without an explicit side_effect_class. */
  sideEffectClass?: SideEffectClass;
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
      action_id: action.action_id ?? `action-${this.#actions.length}`,
      timestamp_ms: action.timestamp_ms ?? Date.now(),
      ...action,
      recording_mode,
      side_effect_class,
    } as ActionEvidence);
    if (action.capability_decision) {
      const cd = action.capability_decision;
      const exists = this.#capabilityDecisions.some(
        (d) =>
          d.capability === cd.capability && d.subject === cd.subject && d.resource === cd.resource
      );
      if (!exists) this.#capabilityDecisions.push(cd);
    }
  }

  addCapabilityDecision(decision: CapabilityDecision): void {
    this.#capabilityDecisions.push(decision);
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
   * Build an unsigned AEPRecord. A placeholder `signature` block is included
   * so the record satisfies the schema (signature is required since v0.2).
   *
   * For a fully signed record use `emit()` instead.
   *
   * @param createdAtMs - Override creation timestamp (defaults to Date.now()).
   * @param signerOverride - Optional: provide a signer to sign inline (async variant).
   *   Prefer `emit()` for async signing.
   */
  build(createdAtMs?: number): AEPRecord {
    const signer = this.#opts.signer;
    if (signer) {
      // Caller should use emit() when a signer is configured — but if they
      // call build() synchronously we return a placeholder-signed record.
      // The placeholder is stable and deterministic; it will fail verifyAEPRecord.
      // This path is only reached in synchronous test helpers.
    }
    const unsigned = this.#buildUnsigned(createdAtMs);
    const placeholder: AEPRecord["signature"] = signer
      ? { alg: "ed25519", key_id: signer.keyId, sig: "UNSIGNED_PLACEHOLDER" }
      : { alg: "ed25519", key_id: "none", sig: "UNSIGNED_PLACEHOLDER" };
    return AEPRecordSchema.parse({ ...unsigned, signature: placeholder });
  }

  /**
   * Build and sign an AEPRecord.
   *
   * Sequence:
   * 1. Assemble the record payload (no signature field yet).
   * 2. Serialise to canonical bytes.
   * 3. Sign with the configured AEPSigner.
   * 4. Attach the `signature` block and validate the full schema.
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
    const unsigned = this.#buildUnsigned(createdAtMs);

    // Parse through zod with a placeholder so that zod normalises the record
    // (applies defaults, strips unknown fields) before we compute canonical bytes.
    // verifyAEPRecord strips `signature` from the already-parsed record and
    // recomputes the same canonical bytes, so both sides are consistent.
    const placeholder: AEPRecord["signature"] = {
      alg: "ed25519",
      key_id: signer.keyId,
      sig: "PLACEHOLDER",
    };
    const normalised = AEPRecordSchema.parse({
      ...unsigned,
      signature: placeholder,
    });
    const { signature: _placeholder, ...normalisedUnsigned } = normalised;
    const bytes = canonicalBytes(normalisedUnsigned);
    const sig = await signer.sign(bytes);
    const signature: AEPRecord["signature"] = {
      alg: "ed25519",
      key_id: signer.keyId,
      sig,
    };
    const record = AEPRecordSchema.parse({ ...normalisedUnsigned, signature });

    // Compute hash of this record (without signature) for the next record's prev_record_hash
    const { signature: _sig, ...recordUnsigned } = record;
    const recordBytes = canonicalBytes(recordUnsigned);
    this.#prevRecordHash = createHash("sha256").update(recordBytes).digest("hex");

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
      ...opts
    } = this.#opts;
    const runSideEffectMax = this.#computeRunSideEffectClassMax();
    return {
      schema_version: "aep/v0.3",
      ...opts,
      ...(this.#userId !== undefined && { user_id: this.#userId }),
      ...(this.#subjectId !== undefined && { subject_id: this.#subjectId }),
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
