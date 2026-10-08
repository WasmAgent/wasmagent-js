---
"@wasmagent/core": minor
---

#505 — dispatch-time re-authorization for $ref-dependent tool calls

Same-batch tool calls whose inputs carry `$ref` placeholders are now
re-authorized **after** their dependencies resolve and **immediately before**
dispatch (Scheduler `authorize` hook), with the run ledger current at that
moment. Previously the whole batch was authorized up-front on an empty
ledger, so a `$ref`-dependent deny-sink could execute with a labeled secret
inside (measured: wasmagent-js#503, reproduction pack case S4). Nodes
without `$ref` placeholders keep their pre-batch decision — batch-internal
concurrency gains no nondeterministic happens-before. The parallel scheduler
now rejects `$ref` placeholders with an explicit `execution_error` instead
of silently dispatching them as literal strings. Confirm decisions
re-evaluated mid-batch degrade to fail-closed deny (`consent-unavailable`)
— resubmit such calls in a later step.
