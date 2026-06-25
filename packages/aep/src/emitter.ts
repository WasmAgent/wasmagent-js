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

  build(createdAtMs?: number): AEPRecord {
    return AEPRecordSchema.parse({
      schema_version: "aep/v0.1",
      ...this.#opts,
      input_refs: this.#inputRefs,
      output_refs: this.#outputRefs,
      capability_decisions: this.#capabilityDecisions,
      actions: this.#actions,
      verifier_results: this.#verifierResults,
      budget_ledger: this.#budgetLedger,
      created_at_ms: createdAtMs ?? performance.now(),
    });
  }

  static digestContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
