import { createHash } from "node:crypto";
import type {
  ActionEvidence,
  AEPRecord,
  BudgetLedger,
  CapabilityDecision,
  InputRef,
  OutputRef,
  VerifierResult,
} from "./types.js";
import { AEPRecordSchema } from "./types.js";
import type { AEPSigner } from "./signer.js";
import { canonicalBytes } from "./canonical.js";

export interface AEPEmitterOptions {
  run_id: string;
  trace_id?: string;
  parent_trace_id?: string | null;
  repo_commit?: string;
  runtime_version?: string;
  model_provider?: string;
  model_id?: string;
  policy_bundle_digest?: string;
  tool_manifest_digest?: string;
  /** Optional signer. When provided, emit() signs the record; build() remains unsigned-compatible via a dummy placeholder. */
  signer?: AEPSigner;
}

export class AEPEmitter {
  readonly #opts: AEPEmitterOptions;
  readonly #actions: ActionEvidence[] = [];
  readonly #capabilityDecisions: CapabilityDecision[] = [];
  readonly #inputRefs: InputRef[] = [];
  readonly #outputRefs: OutputRef[] = [];
  readonly #verifierResults: VerifierResult[] = [];
  #budgetLedger: BudgetLedger | undefined;

  constructor(opts: AEPEmitterOptions) {
    this.#opts = opts;
  }

  addAction(
    action: Omit<ActionEvidence, "action_id" | "timestamp_ms"> & {
      action_id?: string;
      timestamp_ms?: number;
    }
  ): void {
    this.#actions.push({
      action_id: action.action_id ?? `action-${this.#actions.length}`,
      timestamp_ms: action.timestamp_ms ?? performance.now(),
      ...action,
    } as ActionEvidence);
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
   * @param createdAtMs - Override creation timestamp (defaults to performance.now()).
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
    const normalised = AEPRecordSchema.parse({ ...unsigned, signature: placeholder });
    const { signature: _placeholder, ...normalisedUnsigned } = normalised;
    const bytes = canonicalBytes(normalisedUnsigned);
    const sig = await signer.sign(bytes);
    const signature: AEPRecord["signature"] = {
      alg: "ed25519",
      key_id: signer.keyId,
      sig,
    };
    return AEPRecordSchema.parse({ ...normalisedUnsigned, signature });
  }

  #buildUnsigned(createdAtMs?: number): Omit<AEPRecord, "signature"> {
    // biome-ignore lint/correctness/noUnusedVariables: signer is intentionally excluded from the unsigned payload
    const { signer: _signer, ...opts } = this.#opts;
    return {
      schema_version: "aep/v0.2",
      ...opts,
      input_refs: this.#inputRefs,
      output_refs: this.#outputRefs,
      capability_decisions: this.#capabilityDecisions,
      actions: this.#actions,
      verifier_results: this.#verifierResults,
      budget_ledger: this.#budgetLedger,
      created_at_ms: createdAtMs ?? performance.now(),
    };
  }

  static digestContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
