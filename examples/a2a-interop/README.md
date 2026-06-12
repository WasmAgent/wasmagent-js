# a2a-interop example

End-to-end demo proving `@agentkit-js/a2a` implements the
[A2A v1.0 protocol](https://github.com/google/A2A) correctly. Two complementary paths
run inside a single Node process:

| Path | Direction | What it proves |
|---|---|---|
| **A** | external client → `createA2AServer(agent, …)` via raw `fetch` | Any A2A-compliant framework (Google ADK, CrewAI 1.14+, Langroid) can drive an agentkit-js agent without modification |
| **B** | agentkit-js → `A2ARemoteAgent.asTool(…)` → A2A server | An agentkit-js agent can call out to an A2A server (typically ADK / CrewAI / your own) the same way it calls any other tool |

```bash
node examples/a2a-interop/index.mjs
```

Expected output:

```
✓ A2A server running at http://localhost:41789

=== Path A: external framework speaks raw HTTP ===
  ↪ Discovered agent: Inventory Agent (protocol 1.0)
  ↪ Skills: inventory.lookup
  ↪ Task endpoint: http://localhost:41789/tasks
  ✓ agent card schema valid for A2A v1.0
  ↪ Task task-… → status=completed
  ↪ Reply: There are 42 widgets in stock.
  ✓ external HTTP client got the answer through A2A

=== Path B: agentkit-js → A2ARemoteAgent → A2A server ===
  ↪ Re-discovered card via A2ARemoteAgent: Inventory Agent
  ↪ Direct tool call: There are 42 widgets in stock....
  ✓ A2ARemoteAgent.asTool() round-trips through the protocol

✓ A2A server stopped cleanly
```

## Why no real ADK / CrewAI?

Those frameworks have their own test harnesses + runtime requirements that don't
belong in-tree. What we *can* do — and what this demo does — is prove the **bytes
on the wire** match the A2A v1.0 spec:

- Discovery: `GET /.well-known/agent-card` returns the spec-mandated fields
  (`id`, `name`, `protocolVersion`, `capabilities`, `taskEndpoint`).
- Task submission: `POST /tasks` with `{ id, message, parentId? }` returns
  `{ taskId, status, result }`.

Anything that speaks A2A v1.0 (the spec is small and stable) will work against this
server. The reverse direction (Path B) shows the same protocol works as a client.

## Two interop knobs you may want to flip

- `createA2AServer(…, { skills: [...] })` — add capability tags so external
  frameworks' planners know what your agent is good at.
- `A2ARemoteAgent.asTool({ apiKey, timeoutMs })` — when calling out to an
  authenticated A2A endpoint (ADK production deployments, hosted CrewAI, etc.).

See [`packages/a2a/README.md`](../../packages/a2a/README.md) for the full surface.
