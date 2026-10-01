---
"@wasmagent/mcp-server": patch
---

fix(mcp-server): align JSON-RPC notification semantics on Streamable HTTP with JSON-RPC 2.0 / MCP transport spec

- A lone notification POSTed to the MCP endpoint now returns **202 Accepted** with an empty body instead of 200 with an `id: null` method-not-found error.
- Inside a batch, notifications are handled for side effects and produce **no response entry** (previously they produced an `id: null` error entry); an all-notification batch returns **204**.
- Non-object batch items keep their parse-error responses. Pinned by `PROTO-NOTIF-01..03` in `packages/mcp-server/src/protocol-conformance.test.ts` (closes GAP-BATCH-NOTIF from the protocol matrix).
