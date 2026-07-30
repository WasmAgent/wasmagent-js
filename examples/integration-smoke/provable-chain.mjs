/**
 * Provable-chain smoke: the end-to-end "provable agent" pipeline across the
 * freshly-built workspace packages, with NO external services and NO LLM.
 *
 *   task output ──▶ @wasmagent/compliance (verify against a TaskSpec, backed
 *                    by @wasmagent/core's VerificationPipeline)
 *              ──▶ @wasmagent/aep (record the step + the verifier result as
 *                    signed AEP evidence, then verify the signature)
 *
 * This is the release gate for cross-package contract drift on the provable
 * chain: if a change to @wasmagent/core, @wasmagent/compliance, or
 * @wasmagent/aep breaks the seam that lets a verified task turn into signed,
 * verifiable evidence, this script goes red BEFORE the packages are published.
 *
 * It imports bare `@wasmagent/*` specifiers, which bun resolves to the local
 * workspace builds — so it exercises what is about to ship, not what is on npm.
 *
 * NOTE: the trust-passport link (@openagentaudit/passport) is intentionally
 * NOT exercised here: it is an external published dependency, not a workspace
 * package, so a wasmagent-js pre-publish gate cannot meaningfully guard it.
 */
import { DeterministicVerifier, VerificationPipeline } from "@wasmagent/core";
import { ComplianceVerifier } from "@wasmagent/compliance";
import { AEPEmitter, createLocalSignerFromSeed, verifyAEPRecord } from "@wasmagent/aep";

let failed = 0;
function ok(label) {
  console.log(`✓ ${label}`);
}
function fail(label, detail) {
  console.error(`✗ ${label}`, detail ?? "");
  failed++;
}

// A minimal, self-contained TaskSpec: the produced object must contain the
// substring "approved" (a stand-in for a real compliance constraint). This
// uses the DeterministicVerifier's `file_contains` method against the object
// exposed as "object.json" by ComplianceVerifier.verifyObject.
const taskSpec = {
  id: "provable-chain.smoke.v1",
  intent: "produce_compliant_decision",
  language: "en",
  constraints: [
    {
      id: "must-be-approved",
      description: 'decision object must contain "approved"',
      verify_method: "file_contains",
      arg: "approved",
      path: "object.json",
      level: "hard",
      priority: 100,
      category: "content",
    },
  ],
  priority_hierarchy: ["system_policy", "user_explicit_constraints"],
};

// ── 1. A compliant task output passes compliance; a non-compliant one fails.
//      Proves core's VerificationPipeline + DeterministicVerifier + compliance
//      enrichment agree on a verdict.

let compliantResult;
{
  const compliant = { decision: "approved", reason: "vendor on whitelist" };
  const nonCompliant = { decision: "blocked", reason: "budget exceeded" };

  compliantResult = await ComplianceVerifier.verifyObject(compliant, taskSpec);
  const badResult = await ComplianceVerifier.verifyObject(nonCompliant, taskSpec);

  if (!compliantResult.ok) {
    fail("compliance: compliant object should pass", compliantResult.violations);
  } else if (compliantResult.passing_constraint_ids.length !== 1) {
    fail("compliance: expected 1 passing constraint", compliantResult.passing_constraint_ids);
  } else {
    ok("compliance: compliant object passes, non-compliant fails");
  }

  if (badResult.ok) {
    fail("compliance: non-compliant object should fail", badResult);
  } else if (!badResult.violations.some((v) => v.constraint_id === "must-be-approved")) {
    fail("compliance: expected must-be-approved violation", badResult.violations);
  }
}

// ── 2. The compliance verdict becomes SIGNED AEP evidence that verifies.
//      Proves the compliance→AEP seam: a VerifierResult built from a
//      ComplianceVerificationResult round-trips through emit()+verifyAEPRecord.

{
  const seed = "deadbeef".repeat(8); // 64 hex chars — deterministic test key
  const signer = createLocalSignerFromSeed(seed, "provable-chain-smoke-key");
  const emitter = new AEPEmitter({ run_id: "provable-chain-smoke-run", signer });

  // The task step that produced the decision.
  emitter.addAction({ tool_name: "make_decision", state_changing: false });
  // Bridge: the compliance result → an AEP verifier result.
  emitter.addVerifierResult({
    verifier_id: taskSpec.id,
    passed: compliantResult.ok,
    score: compliantResult.ok ? 1 : 0,
    claim_ids: compliantResult.passing_constraint_ids,
  });

  const record = await emitter.emit(1_700_000_000_000);
  if (record.verifier_results.length !== 1) {
    fail("aep: expected 1 verifier_result on the record", record.verifier_results);
  } else if (!record.verifier_results[0].passed) {
    fail("aep: verifier_result should reflect a passing compliance run", record.verifier_results);
  } else if (record.actions.length !== 1) {
    fail("aep: expected 1 action on the record", record.actions);
  } else {
    ok("aep: signed record carries the action + compliance verifier result");
  }

  const publicKey = await signer.getPublicKey();
  const valid = await verifyAEPRecord(record, publicKey);
  if (!valid) {
    fail("aep: signature verification failed on freshly emitted record");
  } else {
    ok("aep: emitted record verifies against its signer public key");
  }

  // Tamper-evidence: mutating the record must break verification.
  const tampered = { ...record, run_id: "tampered-run" };
  const tamperedValid = await verifyAEPRecord(tampered, publicKey);
  if (tamperedValid) {
    fail("aep: tampered record should NOT verify");
  } else {
    ok("aep: tampered record is rejected (tamper-evident)");
  }
}

if (failed > 0) {
  console.error(`\n[provable-chain] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[provable-chain] all checks passed`);
process.exit(0);
