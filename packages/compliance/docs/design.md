# @wasmagent/compliance — Design Note

> Status: **Phase 0 alpha.** Last updated: 2026-06-24.

This document fixes the contract between `@wasmagent/compliance` and the rest of the
wasmagent-js workspace so future commits don't drift.

## 1. The "extends Criterion" contract

`@wasmagent/core` already defines a deterministic verifier protocol:

```ts
interface Criterion {
  id: string;
  description: string;
  verify_method: string;     // open string union
  arg?: unknown;
  path?: string;
}
interface Verifier {
  readonly methods: readonly string[];
  verify(c: Criterion, ws: WorkspaceReader): Promise<CriterionVerdict>;
}
```

**Rule:** `ConstraintIR extends Criterion` structurally. Anything that runs in
`VerificationPipeline` runs here unchanged. We add `level`, `priority`, `category`, and
`repair` as orthogonal axes — they do not change verifier dispatch, which stays keyed on
`verify_method`.

**Why this matters.** When Phase 2 lands `IFEvalVerifier`, `JSONSchemaVerifier`, and
`ToolCallVerifier`, each is a plain `Verifier` registered into a `VerificationPipeline`. The
compliance layer never reaches into the verifier — it only consumes the verdict and enriches
it. This means:

- `BuildPassesVerifier` already works on `ConstraintIR` today.
- `ScalarLLMJudgeVerifier` is our default L3 (semantic) verifier — no fork needed.
- Custom enterprise verifiers added to a private `compliance-engine-research` repo register
  through the same registration API.

If a future change makes `ConstraintIR` *not* extend `Criterion`, this is a breaking change
and must be called out in a Changeset.

## 2. evidence_span: where to repair

`CriterionVerdict.hint` is a string. Strings don't tell `RepairPlanner` which region to
rewrite. We add `evidence_span` on the **violation**, not the verdict — verifier authors
don't need to change.

Locator preference order (planner picks the most specific one available):

```
json_pointer > region_id > line_range > char_range
```

Verifier authors compute the span via an `EvidenceSpanHook` keyed on `verify_method`. The
default span (when no hook is registered) is `{ region_id: "path:<file>" }` — coarse but
always non-empty, so the planner can fall back to `regenerate_region`.

**Phase 0 commitment:** every `ConstraintViolation` carries at least one locator. Tests
enforce this via `EvidenceSpanSchema.refine(...)`.

## 3. Priority resolution is a planner concern, not a verifier concern

A verifier reports what it sees. It does not know that a user-explicit `length≤100` overrides
a style-preference `length≥500`. The `RepairPlanner` (Phase 0 Day 6-7) consumes the violation
list and uses `TaskSpec.priority_hierarchy` + `ConstraintIR.priority` to:

1. Drop violations that are dominated by higher-priority constraints.
2. Order surviving violations by `(hierarchy_index, -priority)`.
3. Pick a repair strategy per violation.

This split keeps the verifier layer easy to reason about (no spec-wide context needed) and
the planner narrow (only the constraint metadata, not the verifier internals).

## 4. Repair strategy taxonomy

| Strategy            | Use case                                | Cost   |
|---------------------|------------------------------------------|--------|
| `patch`             | Missing keyword, wrong fragment          | Lowest |
| `insert_section`    | Markdown section / JSON field missing    | Low    |
| `regenerate_region` | A bounded region (section, field, args)  | Medium |
| `full`              | Last resort                              | High   |

The planner starts with the strategy declared on `ConstraintIR.repair.strategy` (or
`TaskSpec.repair.default_strategy`) and escalates by one rank if a round fails to clear the
violation. Escalation budget is `TaskSpec.repair.max_rounds`.

**Non-goal for Phase 0:** cross-constraint repair (one patch resolving multiple violations).
That's a Phase 1 optimisation; Phase 0 plans one repair per violation.

## 5. EvoMerge / RolloutMemoryStore boundary

`ComplianceEvalRecord` (`schemas/compliance-eval-record.schema.json`) is **self-contained**
in Phase 0. It is *not* yet aligned with the `RolloutMemoryStore` JSONL schema in
`packages/core/src/enhancement/RolloutMemoryStore.ts`.

**Phase 1 Day 1 task:** read `RolloutMemoryStore` and decide whether to:
- (a) embed `ComplianceEvalRecord` as a sub-object inside an existing rollout record, or
- (b) emit a sibling JSONL stream that joins on `task_spec_hash` + run timestamp.

Recommendation pending that read: **(a)**, because all downstream consumers
(`RolloutRanker`, `RolloutForkRunner`) already know how to walk one JSONL. Two streams
double the contamination-guard surface.

## 6. What this package is not

- Not an Instruction Compiler. Phase 0 hand-writes `TaskSpec`s. Auto-compilation from
  natural language (`NL → TaskSpec`) is Phase 2+ and lives in
  `compliance-engine-research` (private repo) until it's stable.
- Not a constrained-decoding engine. We compose with XGrammar / Outlines via existing
  model adapters (`@wasmagent/model-local`, `@wasmagent/model-anthropic`); the compliance
  layer is post-decode.
- Not a generic Guardrails replacement. We're optimised for **multi-step agent run
  evidence**, not single-call input/output guards.

## 7. Open questions (resolve before Phase 1)

1. **Region addressing for Markdown.** `region_id: "section:Conclusion"` works when section
   names are unique. What about repeated sections? Tentative answer: append a 1-based ordinal
   (`section:Conclusion#2`). Defer until a benchmark sample forces the question.
2. **Tool-call evidence_span.** A failed BFCL constraint needs to point at a tool call in a
   trajectory. Likely shape: `region_id: "tool_call:<index>"` + `json_pointer` into the
   args object. Land with `ToolCallVerifier` in Phase 2.
3. **Soft-violation budget.** Should soft violations contribute to `final_pass`? Current
   answer: no — only hard violations gate. Soft violations are recorded and exported but
   don't trigger repair unless explicit `repair.strategy` is set on the constraint.

## 8. Phase 0 acceptance checklist

- [x] `ConstraintIR extends Criterion` compiles and tests pass.
- [x] Every `ConstraintViolation` carries at least one locator.
- [x] JSON schemas mirror the TS types (manual sync; switch to `zod-to-json-schema` in
      Phase 1).
- [x] `ComplianceVerifier` round-trips a TaskSpec through `VerificationPipeline` without
      introducing a parallel dispatch path.
- [ ] `RepairPlanner` + 3 strategies (patch / insert_section / regenerate_region).
- [ ] `ComplianceRun` orchestrator producing a `ComplianceEvalRecord`.
- [ ] `IFEvalVerifier` covering ≥15 IFEval instruction classes.
- [ ] 50-sample IFEval benchmark, 3 baselines, first results table.
