# MCP Protocol Conformance — support matrix view

> GENERATED from `packages/mcp-firewall/evals/protocol/mcp-protocol-matrix.json` — that JSON file is the authority. Do not edit this view by hand; run `node packages/mcp-firewall/evals/protocol/render-protocol-matrix.mjs` after editing the matrix.

- Repository: `WasmAgent/wasmagent-js`
- Tested commit: `c1a573fc8f49f0f2162a17ddca199bb61fcdd94d`
- @wasmagent/mcp-firewall: `2.2.1`, @wasmagent/mcp-server: `1.1.16`
- Evidence anchor: `docs/security/mcp-firewall-hardening-checkpoint.md`

## Status vocabulary (no generic green/red)

- **verified** — an automated test at tested_sha pins the behavior named in the row
- **partially-verified** — some sub-behavior is test-pinned, a named conformance gap or untested sub-behavior remains
- **implemented-not-conformance-tested** — code ships but no automated conformance test pins it
- **not-implemented** — no implementation; a truthful terminal status, not a deficiency of this matrix
- **not-evaluated** — existence/behavior plausible but never measured here
- **not-applicable** — surface does not apply to this package boundary

## Protocol revisions

| id | surface | status | evidence | owner | claim ceiling |
| --- | --- | --- | --- | --- | --- |
| REV-2025-03-26 | MCP 2025-03-26 (Streamable HTTP introduced) | implemented-not-conformance-tested | packages/core/src/tools/McpToolCollection.ts::fromHttp (Streamable HTTP first, SSE fallback) | @wasmagent/core | client-side transport support only; no server-side or wire conformance run against a 2025-03-26 suite |
| REV-2025-06-18 | MCP 2025-06-18 (structured tool output) | implemented-not-conformance-tested | packages/core/src/tools/McpToolCollection.ts (2025-06-18+ structuredContent handling); fromHttp transport | @wasmagent/core | structuredContent is parsed client-side; no dedicated conformance test for this revision |
| REV-2025-11-25 | MCP 2025-11-25 stable (over-the-wire target) | partially-verified | packages/mcp-server/src/McpAgentServer.test.ts (initialize advertises 2025-11-25; tools/*; tasks/*); packages/mcp-server/src/stdio.test.ts (framing); packages/mcp-server/src/protocol-conformance.test.ts (envelope/negotiation/batch pins) | @wasmagent/mcp-server | verified for the methods/transports listed in this matrix; resources/* and prompts/* are NOT implemented; request cancellation (notifications/cancelled) is NOT implemented; zero-escape firewall claims are orthogonal and live in the F2 report |
| REV-2026-07-28-RC | MCP 2026-07-28 Release Candidate | not-evaluated | packages/mcp-server/src/index.ts:20-23 (design constraints); packages/mcp-server/src/McpAgentServer.ts:20-26 (older protocolVersion strings accepted during deprecation window) | @wasmagent/mcp-server | DESIGNED WITHIN RC CONSTRAINTS (stateless core, no Mcp-Session-Id reliance, server never initiates requests, elicitation only inside an active request) — this is NOT 2026-07-28 conformance; no RC conformance suite has been run |

- **REV-2025-03-26** notes: No revision-specific gating exists in mcp-server; earlier revisions are served by the same handler without behavioral switch.
- **REV-2025-11-25** notes: PROTOCOL_VERSION = 2025-11-25 (McpAgentServer.ts). Declared capabilities: tools + tasks only.
- **REV-2026-07-28-RC** notes: Deliberate wording boundary: 'compatible-by-design' must never be read as 'conformant'.

## Transport / framing

| id | surface | status | evidence | owner | claim ceiling |
| --- | --- | --- | --- | --- | --- |
| TF-STDIO | stdio transport (newline-delimited JSON-RPC) | verified | packages/mcp-server/src/stdio.test.ts::STDIO-01..04 | @wasmagent/mcp-server | one message per line; stderr is log-only; framing per 2025-11-25 transports spec |
| TF-STREAMABLE-HTTP | Streamable HTTP transport | verified | packages/mcp-server/src/McpAgentServer.test.ts (route/OPTIONS/POST cases); packages/mcp-server/src/fetchHandler.ts | @wasmagent/mcp-server | POST JSON-RPC at a single configurable path with CORS + optional auth; no SSE response stream, no resumability replay |
| TF-SSE-SERVER | Legacy HTTP+SSE server transport | not-implemented | absence in packages/mcp-server/src (only fetchHandler exists) | @wasmagent/mcp-server | server-side SSE endpoint does not exist |
| TF-SSE-CLIENT | SSE fallback (client side) | implemented-not-conformance-tested | packages/core/src/tools/McpToolCollection.ts::fromSse / fromHttp fallback | @wasmagent/core | used only when Streamable HTTP is unavailable (SDK >= 1.7.0 required for Streamable) |
| TF-SESSIONLESS | Sessionless HTTP behavior (no Mcp-Session-Id reliance) | verified | packages/mcp-server/src/fetchHandler.ts (never reads Mcp-Session-Id); packages/mcp-server/src/McpAgentServer.test.ts (fresh server instance reads task created by a prior instance) | @wasmagent/mcp-server | every request self-contained; long-task state keyed by task id in a swappable store |
| TF-JSONRPC-SINGLE | JSON-RPC single request over HTTP | verified | packages/mcp-server/src/McpAgentServer.test.ts (POST returns the JSON-RPC body) | @wasmagent/mcp-server |  |
| TF-JSONRPC-BATCH | JSON-RPC batch (array body) | verified | packages/mcp-server/src/McpAgentServer.test.ts (handles batch requests); packages/mcp-server/src/protocol-conformance.test.ts (PROTO-BATCH-01 batch-too-large 413, PROTO-DUPID-01 duplicate ids, PROTO-NOTIF-01/02 notification handling) | @wasmagent/mcp-server | maxBatchSize default 20 (413 beyond); stdio framing carries no batches (one message per line) |
| TF-MALFORMED-JSON | Malformed JSON | verified | packages/mcp-server/src/stdio.test.ts (-32700 with id null); packages/mcp-server/src/McpAgentServer.test.ts (400 Invalid JSON over HTTP) | @wasmagent/mcp-server |  |
| TF-MALFORMED-ENVELOPE | Malformed JSON-RPC envelope (wrong jsonrpc / missing method / non-object) | verified | packages/mcp-server/src/McpAgentServer.test.ts (parse-error + invalid-request cases); packages/mcp-server/src/protocol-conformance.test.ts (PROTO-ENV-01 echoes request id on -32600) | @wasmagent/mcp-server |  |
| TF-REQUEST-ID-EDGE | Duplicate / null request-id edge cases | verified | packages/mcp-server/src/protocol-conformance.test.ts (PROTO-DUPID-01: duplicate ids in one batch each answered; PROTO-ENV-01: id echoed on envelope errors) | @wasmagent/mcp-server | the server answers each request independently; id correlation is the host's responsibility (documented) |
| TF-DISCONNECT | Disconnect / reconnect | partially-verified | packages/mcp-server/src/stdio.test.ts (stdin close exits); packages/mcp-server/src/McpAgentServer.test.ts (stateless task store: fresh instance resumes a prior instance's task) | @wasmagent/mcp-server | resume is task-store-based (kill-and-resume), not transport-level replay; host re-initializes after reconnect |
| TF-TIMEOUT | Sync-call timeout escalation | verified | packages/mcp-server/src/McpAgentServer.test.ts (escalates to Tasks API when the sync timeout fires) | @wasmagent/mcp-server | default 25s sync timeout; escalation returns _meta.taskId, state persists |
| TF-CANCEL-TASK | Task cancellation (tasks/cancel) | verified | packages/mcp-server/src/McpAgentServer.test.ts (tasks/cancel marks an in-flight task as failed) | @wasmagent/mcp-server |  |
| TF-CANCEL-REQUEST | Request cancellation (notifications/cancelled) | not-implemented | notifications are never dispatched to handlers (packages/mcp-server/src/stdio.ts; packages/mcp-server/src/stdio.test.ts notification case) | @wasmagent/mcp-server | in-flight request cancellation is NOT supported; use tasks/cancel for long-running work |
| TF-CONCURRENCY | Concurrent requests on one server instance | verified | packages/mcp-server/src/protocol-conformance.test.ts (PROTO-CONC-01); packages/mcp-server/src/stdio.ts handles lines without awaiting the previous one | @wasmagent/mcp-server | per-request isolation; ordering across requests is not guaranteed (host correlates by id) |
| TF-BACKPRESSURE | Backpressure / flow control | not-evaluated | no flow-control mechanism in packages/mcp-server/src | @wasmagent/mcp-server | only bounds that exist: 1 MiB request-body cap, 20-item batch cap, 200-event task log cap |

- **TF-STDIO** notes: console.log is redirected to stderr to protect the wire format.
- **TF-SSE-SERVER** notes: Client-side SSE fallback is a separate row (TF-SSE-CLIENT).
- **TF-JSONRPC-BATCH** notes: GAP-BATCH-NOTIF resolved: notifications inside a batch get no response entry; all-notification batches return 204.
- **TF-BACKPRESSURE** notes: No measurement of behavior under sustained overload exists.

## MCP methods / surfaces

| id | surface | status | evidence | owner | claim ceiling |
| --- | --- | --- | --- | --- | --- |
| M-INITIALIZE | initialize | verified | packages/mcp-server/src/McpAgentServer.test.ts (advertises protocolVersion 2025-11-25, tools+tasks capabilities); packages/mcp-server/src/protocol-conformance.test.ts (PROTO-INIT-01) | @wasmagent/mcp-server | capability flags are objects per spec convention (Zod-validated by major hosts) |
| M-NEGOTIATION | Protocol-version negotiation (echo/agree with client preference) | not-implemented | packages/mcp-server/src/protocol-conformance.test.ts (PROTO-INIT-01: a 2025-06-18 client request still receives 2025-11-25) | @wasmagent/mcp-server | server always declares its own stable version; older strings are tolerated by design (deprecation windows), never echoed |
| M-PING | ping | verified | packages/mcp-server/src/McpAgentServer.test.ts (ping returns an empty result) | @wasmagent/mcp-server |  |
| M-TOOLS-LIST | tools/list | verified | packages/mcp-server/src/McpAgentServer.test.ts (default tool; longRunning _meta) | @wasmagent/mcp-server | listChanged: false — no tools/list_changed notifications |
| M-TOOLS-CALL | tools/call | verified | packages/mcp-server/src/McpAgentServer.test.ts (final_answer content blocks; -32602 missing name; -32011 unknown tool) | @wasmagent/mcp-server |  |
| M-RESOURCES | resources/* (resources/list, resources/read, …) | not-implemented | absence in McpAgentServer.handle dispatch; initialize capabilities declare tools+tasks only | @wasmagent/mcp-server | no MCP resource server surface |
| M-PROMPTS | prompts/* (prompts/list, prompts/get) | not-implemented | absence in McpAgentServer.handle dispatch | @wasmagent/mcp-server | no MCP prompt server surface |
| M-NOTIFICATIONS | Notifications (no-id messages) | verified | packages/mcp-server/src/stdio.test.ts (notification gets NO response); packages/mcp-server/src/protocol-conformance.test.ts (PROTO-NOTIF-01..03 over HTTP/batch) | @wasmagent/mcp-server | notifications are handled for side effects only, never answered (stdio, single HTTP 202, batch entries dropped); server emits no notifications (listChanged false, no progress) |
| M-TASKS | Tasks API (tasks/create, tasks/get, tasks/cancel, tasks/respond, tasks/list) | verified | packages/mcp-server/src/McpAgentServer.test.ts (create/get/cancel/respond/list; -32010 unknown id; -32012 not-awaiting; stateless store resume) | @wasmagent/mcp-server | InMemoryTaskStore default; KV-swappable via McpTaskStore; sync-timeout escalation shares the same store |
| M-ELICITATION | Elicitation (await_human_input via tasks/respond) | verified | packages/mcp-server/src/McpAgentServer.test.ts (tasks/respond clears pendingElicitation; -32012 on non-awaiting) | @wasmagent/mcp-server | elicitation happens only inside an active task (2026-07-28-RC-compatible design constraint) |
| M-SAMPLING-SERVER | sampling/createMessage (server-initiated) | not-implemented | absence in mcp-server; sampling callback exists client-side | @wasmagent/mcp-server | server never initiates requests (sessionless design constraint) |
| M-SAMPLING-CLIENT | Sampling callback (client side) | implemented-not-conformance-tested | packages/core/src/tools/McpToolCollection.ts (sampling/createMessage registration; pre-model vetting hook) | @wasmagent/core |  |
| M-EXTENSIONS | Extension methods / unknown method handling | verified | packages/mcp-server/src/McpAgentServer.test.ts (unknown method → -32601); packages/mcp-server/src/protocol-conformance.test.ts (PROTO-ENV-01) | @wasmagent/mcp-server | no extension surface; typed MCP error codes (-32010/-32011/-32012) honored from thrown errors |

- **M-NEGOTIATION** notes: Documented stance, tested as documentation — not spec-mandated negotiation.
- **M-TOOLS-CALL** notes: Firewall-side call gating is the MCPGateway surface, see firewall_inspection section.
- **M-RESOURCES** notes: Truthful not-implemented; not scheduled by this matrix.
- **M-SAMPLING-SERVER** notes: Client-side sampling callback: see M-SAMPLING-CLIENT.

## Firewall inspection direction

| id | surface | status | evidence | owner | claim ceiling |
| --- | --- | --- | --- | --- | --- |
| FI-DESCRIPTOR | Registration / descriptor inspection (vetting at list time) | verified | packages/mcp-firewall/src/firewall.test.ts (vetTool); packages/mcp-firewall/src/gateway.test.ts (server card + evaluate); evals F0/F1 corpus gates | @wasmagent/mcp-firewall | semantic detection is defence-in-depth, not the root of trust |
| FI-REQUEST-INSPECTION | Client → server request inspection (per-invocation gateway) | verified | packages/mcp-firewall/src/gateway-hardening.test.ts (WIRE-01..07) | @wasmagent/mcp-firewall |  |
| FI-CALL-ARGS-POLICY | Call-argument policy (structural value signals, tenant, sinks) | verified | packages/mcp-firewall/src/gateway-hardening.test.ts (TENANT-ADV-01..06, STRUCT-ADV-01..08); packages/mcp-firewall/src/resource-adversarial.test.ts (PATH-ADV, SSRF) | @wasmagent/mcp-firewall | name heuristics are supplementary; profiles/structural signals are authoritative |
| FI-RESULT-HANDLING | Server → client result handling (taint observation, quarantine rendering) | verified | packages/mcp-firewall/src/taint-labels.test.ts; gateway.wrapResult / renderTaintedObservation (base64 boundary) | @wasmagent/mcp-firewall | rendering-level boundary for prompt assembly; NOT a response-content DLP product |
| FI-TAINT-PROPAGATION | Taint label propagation across derived observations | verified | packages/mcp-firewall/src/taint-labels.test.ts (propagateTaint) | @wasmagent/mcp-firewall | explicit propagation via API calls; no automatic process-wide taint ledger |
| FI-RESULT-TO-NEXT-CALL | Result-to-next-call information flow (post-call reuse as arguments) | partially-verified | packages/mcp-firewall/src/gateway-hardening.test.ts (value-driven secret→network deny); bounded cross-tool fixtures land with the information-flow workstream | @wasmagent/mcp-firewall | cross-tool effect containment via policy + capability boundaries; semantic result-text detection is not the root of trust |
| FI-RESPONSE-DLP | Response secret/PII enforcement (DLP over returned content) | not-implemented | taint tagging marks observations; no content-scanning DLP over tool results | @wasmagent/mcp-firewall | taint tagging must NOT be presented as response DLP |
| FI-CROSS-TOOL-FLOW | Cross-tool information-flow enforcement | partially-verified | sink-policy rules (SECRET_NETWORK_SINK_RULE, capability registry) constrain cross-boundary effects per call; cross-tool chaining is caller-integrated via propagateTaint | @wasmagent/mcp-firewall | per-call structural boundaries are enforced; automatic cross-tool taint ledger does not exist |

- **FI-RESULT-TO-NEXT-CALL** notes: Dedicated adversarial fixtures tracked in the hardening workstream (PR2).
- **FI-CROSS-TOOL-FLOW** notes: Information-flow fixture family (PR2) documents exactly where boundaries hold.

## Known conformance gaps (explicit, not hidden)

- **GAP-BATCH-NOTIF** (TF-JSONRPC-BATCH, M-NOTIFICATIONS): RESOLVED: a notification inside a JSON-RPC batch used to produce an id:null error entry in the batch reply, and a lone notification over HTTP used to return 200 with an error body instead of 202/no-body. Fixed in the conformance patch; PROTO-NOTIF-01..03 pin the corrected behavior. — disposition: resolved — rows flipped to verified with pinned tests

## Claim ceiling

- This matrix is a project-owned conformance inventory at one tested commit, not an independent certification.
- not-implemented rows are truthful terminal states; nothing here asserts scheduled delivery.
- 2026-07-28-RC compatibility is a design-constraint statement only.
- Firewall rows describe per-call enforcement boundaries; none extends the kernel/sandbox/network-enforcement claim of the runtime.

