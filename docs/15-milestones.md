# Milestones

## Milestone 1: Core Evidence Record Foundation

### Deliverables
- [ ] Implement the AEP record builder with required `run_id`, `model_id`, timestamp, action list, and schema version fields
- [ ] Add JSON Schema validation for `aep/v0.1` records in `@wasmagent/aep`
- [ ] Implement `AEPEmitter.addAction()` for tool name, outcome, exit code, arguments hash, and result hash capture
- [ ] Add deterministic canonical serialization for signed evidence payloads
- [x] Implement record signing and signature verification utilities
- [ ] Add unit tests for valid records, invalid records, signature verification, and malformed action entries

## Milestone 2: MCP Firewall Protection Layer

### Deliverables
- [ ] Implement `snapshotTool()` to hash MCP tool descriptors at registration time
- [ ] Implement `vetTool()` static checks for prompt injection, data exfiltration, and descriptor mutation risks
- [ ] Implement `evaluatePolicy()` with `allow`, `deny`, and `ask_user` decisions
- [ ] Add consent record storage and lookup for repeated policy decisions
- [ ] Implement `taintObservation()` to tag tool outputs with boundary and source metadata
- [ ] Add integration tests covering denied calls, consent-required calls, allowed calls, and tainted results

## Milestone 3: Sandboxed Execution Runtime

### Deliverables
- [ ] Implement `QuickJSKernel` lifecycle methods for initialize, execute, timeout, and dispose
- [ ] Add host API isolation so sandboxed code cannot access filesystem, process, or network primitives
- [ ] Implement `sandboxedJsTool()` adapter for AI SDK-compatible tool execution
- [x] Add structured execution results with stdout, stderr, return value, timeout status, and error details
- [ ] Add configurable CPU time and memory limits for sandboxed code execution
- [ ] Add tests for successful execution, runtime errors, infinite loops, blocked host access, and disposal behavior

## Milestone 4: Shared State Sync Package

### Deliverables
- [x] Implement reducer-backed shared state primitives in the `@wasmagent/core/shared-state` subpath
- [x] Add projection APIs so agents can read restricted state views
- [x] Implement intent write APIs with validation before reducer dispatch
- [x] Add state change event subscriptions for UI synchronization
- [x] Add TypeScript types for reducers, projections, intents, and state snapshots
- [x] Add tests for reducer updates, projection filtering, invalid intents, and UI subscription notifications

## Milestone 5 — Durable Evidence Ledger & Chain Verification

### Deliverables
- [ ] Implement an `EvidenceStore` interface with pluggable backends (in-memory, filesystem) for durable AEP record persistence across sessions
- [ ] Add append-only chain-linking so each record references the previous record's content hash, producing a tamper-evident run history
- [ ] Implement `verifyChain()` to validate per-record signatures, ordering, and hash continuity across a stored run or full agent history
- [ ] Add query/filter APIs for lookup by `run_id`, `model_id`, time range, action type, and tool name
- [ ] Implement a replay API that reconstructs an ordered action timeline from stored records for post-hoc inspection and debugging
- [ ] Add an export adapter that emits a verifiable evidence bundle consumable by `@wasmagent/trust-cli` and external auditors
- [ ] Add retention and compaction policies (time-bound and count-bound) with safe pruning of verified record tails
- [ ] Wire the `AEPEmitter` to optionally stream records to a configured `EvidenceStore` at emission time
- [ ] Add tamper-detection tests covering mutated records, reordered entries, broken hash links, and invalid signatures
- [ ] Add integration tests for concurrent appends, cross-run queries, export round-trips, and replay fidelity

## Milestone 6 — Distributed Evidence Stream & Multi-Agent Scenarios

### Deliverables
- [ ] Implement `EvidenceStream` pub/sub interface for real-time AEP record broadcasting across agent processes and network boundaries
- [x] Add `AgentGroup` orchestration primitives so multiple agents can coordinate on shared tasks with cross-linked evidence chains
- [ ] Implement `EvidenceRouter` for intelligent record routing — local vs remote storage, archival tiers, and selective broadcast to subscribed auditors
- [x] Add evidence record compaction and rollup APIs for long-running sessions, preserving cryptographic chain proofs while compressing repetitive tool-call payloads
- [ ] Implement `EvidenceMirror` for bidirectional sync between local EvidenceStore and remote backends (S3, IPFS, PostgreSQL) with conflict resolution
- [ ] Add cross-agent policy inheritance and delegation so parent agent posture policies automatically cascade to spawned sub-agents with evidence tracking
- [ ] Implement real-time evidence monitoring hooks — webhook subscriptions, WebSocket streaming, and in-process observers for compliance dashboards
- [ ] Add evidence-based anomaly detection using statistical models on tool-call patterns, timing, and payload distributions with configurable alert thresholds
