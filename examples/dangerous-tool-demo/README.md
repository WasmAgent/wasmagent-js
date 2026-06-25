# dangerous-tool-demo

Shows WasmAgent MCP Guard blocking dangerous tool calls before execution.

No API key required — the demo uses mock tool descriptors and demonstrates
`@wasmagent/mcp-gateway` policy enforcement and taint tracking.

## Run

```bash
node index.mjs
```

## What you'll see

- ✓ `read_file` — allowed (read-only)
- ✓ `git_status` — allowed (read-only)
- ✗ `rm_rf` — **denied** (tool_poisoning: "ignore previous instructions")
- ✓ `write_file` — allowed (clean descriptor; state-changing flag recorded in AEP evidence)
- ? `fetch_url` — ask_user (exfiltration: references api_key and process.env)
- ✓ Tool result taint tracking (untrusted_tool_output boundary)
