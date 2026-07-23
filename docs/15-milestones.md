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
- [ ] Add structured execution results with stdout, stderr, return value, timeout status, and error details
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