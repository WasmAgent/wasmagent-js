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

## Milestone 7 — Realtime Monitoring & Anomaly Detection

### Deliverables
- [ ] Implement `HealthMonitor` service that continuously polls EvidenceStore for chain gaps, signature failures, and timestamp anomalies
- [ ] Add `AnomalyDetector` with statistical models for detecting abnormal execution patterns (unusual tool call sequences, extreme latency spikes, outlier resource usage)
- [ ] Implement alert emission via pluggable channels (webhook, SSE stream, log sink) for policy violations and chain integrity issues
- [ ] Add metrics aggregation pipeline (Prometheus-compatible) for evidence volume, verification success rate, and policy decision distribution
- [ ] Implement `AuditReportGenerator` to produce human-readable compliance summaries from ledger data (PDF/HTML, executive summary, detailed evidence log)
- [ ] Add dashboard GraphQL queries for realtime evidence chain health, recent anomalies, and policy enforcement statistics
- [ ] Implement `AttestationPublisher` for periodic signed snapshots of ledger state to external witnesses (multi-party verification)
- [ ] Add integration tests for alert delivery, anomaly detection accuracy (synthetic attack patterns), report generation, and witness attestation flow

Looking at the completed milestones, I see the foundation for evidence tracking, policy enforcement, sandboxing, shared state, and chain verification. The natural next step would focus on **operational resilience and multi-agent coordination** — moving from single-agent evidence chains to production-grade multi-agent workflows with recovery and observability.

## Milestone 7 — Distributed Evidence Coordination & Recovery

- Implement `EvidenceCompressor` to generate auditable summaries and cryptographic commitments from long evidence chains, enabling efficient storage and fast verification without sacrificing chain integrity
- Add multi-agent evidence coordination with `run_id` namespace isolation, allowing agent teams to contribute to shared evidence chains while maintaining per-agent provenance boundaries
- Implement `StateRecovery` APIs to reconstruct agent runtime state from historical evidence chains, enabling crash recovery and session resumption with full causality
- Add evidence chain export/import with standardized envelope format for cross-system portability, supporting evidence transfer between organizations and auditing tools
- Implement real-time evidence streaming with `EvidencePublisher` for live monitoring dashboards and external observability pipelines (OpenTelemetry integration)
- Add `EvidencePruner` with configurable retention policies and snapshot checkpoints, enabling long-running agents to manage storage growth while preserving hash continuity
- Implement Byzantine-fault-resistant evidence aggregation for distributed consensus on evidence chain state across multiple verification nodes
- Add evidence-based policy adaptation hooks that allow MCP firewall rules to evolve based on observed action patterns and anomaly detection from historical chains
- Add integration tests for multi-agent evidence merge conflicts, recovery from incomplete chains, cross-system import/export roundtrips, and long-running agent retention

{
  "milestone": "## Milestone 8 — Distributed Trust Relay\n\n- Implement a `TrustRelay` transport that exchanges signed AEP records between independent wasmagent runtimes over WebSocket/HTTP, with automatic reconnection and backoff.\n- Add `verifyRemoteChain()` API that requests a Merkle inclusion proof from a remote `EvidenceStore` and validates it locally without requiring full history download.\n- Add hybrid logical clock (HLC) timestamps to AEP records so distributed agents can be ordered deterministically across machines.\n- Implement an idempotent record ingestion endpoint that rejects duplicate `run_id`/`action_id` pairs and detects fork attempts.\n- Add consent-sync namespace so `ask_user` firewall decisions made on one agent are propagated and honored by sibling agents with the same identity.\n- Add AgentBOM-aware handshake: on connection, agents exchange identity and capability documents, and refuse to relay records from agents whose declared scopes exclude the action.\n- Implement E2E encrypted evidence relay with per-agent key rotation, using the existing canonical serialization for ciphertext metadata.\n- Add network partition simulator and CI chaos tests proving the ledger remains consistent and verifiable under dropped messages and concurrent writes.\n- Expose Prometheus/browser-observability bridge for relay health, chain length divergence, and unresolved verification failures.\n- Add audit export command producing a signed, self-contained run bundle (records + proofs + manifests) shareable with external auditors."
}

## Milestone 8 — Federated Agent Operations & Reliability

- [ ] Implement a versioned run registry for discovering agents, runtimes, capabilities, and health status across deployments
- [ ] Add resumable execution checkpoints so interrupted agent runs can continue without duplicating completed actions
- [ ] Implement idempotency keys and deduplication for retried tool calls and evidence writes
- [ ] Add remote evidence synchronization with batching, backpressure, retry, and offline buffering
- [ ] Provide correlation APIs linking parent runs, delegated agents, tool calls, and shared-state transitions
- [ ] Add runtime health metrics for latency, failures, timeouts, policy denials, and resource consumption
- [ ] Implement configurable retention, redaction, and export policies for operational telemetry and evidence
- [ ] Add incident replay support using recorded inputs, policy decisions, tool outcomes, and deterministic execution metadata
- [ ] Provide conformance tests for interoperability between browser, Node.js, edge, and server-side runtimes
- [ ] Add integration examples for deploying and monitoring multiple cooperating WasmAgent instances

{"milestone":"## Milestone 8 — Run Replay & Forensic Investigation\n\n### Deliverables\n- [ ] Implement a `RunRecorder` that captures all AEP records, shared-state deltas, and sandbox execution logs for a session\n- [ ] Add a time-indexed replay API that reconstructs tool invocations and state mutations from a stored evidence chain\n- [ ] Implement `analyzeRun()` to surface unauthorized access, policy violations, and anomalous tool sequences\n- [ ] Add SARIF and OpenTelemetry exporters so evidence and replay data plug directly into existing observability stacks\n- [ ] Add differential replay: compare two runs from the same `run_id` to detect tool drift, output divergence, or policy changes\n- [ ] Add a query layer for filtering runs by `run_id`, model_id, tool name, policy decision, or time range\n- [ ] Integrate with AgentBOM compliance scoring so replayed runs can emit inventory findings and compliance deltas\n- [ ] Add tests for deterministic replay, corrupted ledger handling, and export schema validation\n- [ ] Add a lightweight CLI (`wasmagent-replay`) to inspect and replay runs outside a live host"}
