# MCP Registry — @wasmagent/mcp-server publication

**Target**: `registry.modelcontextprotocol.io` (official MCP Registry)
**Method**: `mcp-publisher` CLI (NOT a PR to `modelcontextprotocol/servers`)
**Draft date**: 2026-06-25
**Status**: 📋 READY — mechanical steps only, no maintainer approval needed

---

## Why the Registry, not modelcontextprotocol/servers

`modelcontextprotocol/servers` is reference implementations only; its CONTRIBUTING.md
explicitly directs third-party servers to the Registry. The Registry is:
- Searchable at `registry.modelcontextprotocol.io`
- Higher-value than the retired README community list
- The standard path for all third-party servers

---

## Steps (manual — requires browser + GitHub auth)

### 1. Add `mcpName` to `packages/mcp-server/package.json`

```json
{
  "mcpName": "io.github.WasmAgent/mcp-server"
}
```

### 2. Confirm npm package is published

```bash
npm view @wasmagent/mcp-server version
# expected: 1.0.3 or later
```

### 3. Install mcp-publisher

```bash
npm install -g @modelcontextprotocol/mcp-publisher
```

### 4. Generate server.json

```bash
cd packages/mcp-server
mcp-publisher init
```

Review the generated `server.json`:
- `registry`: `"npm"`
- `repositoryUrl`: `"https://github.com/WasmAgent/wasmagent-js"`
- `transport`: `"stdio"` (runStdio is already exported)
- `environmentVariables`: none required for basic usage

### 5. Authenticate and publish

```bash
mcp-publisher publish
# Opens GitHub auth flow; then submits to the Registry
```

### 6. Verify listing

Visit `https://registry.modelcontextprotocol.io` and search for `wasmagent`.

---

## Pre-publication checklist

- [ ] `mcpName` field added to `packages/mcp-server/package.json`
- [ ] `@wasmagent/mcp-server` published to npm (current: 1.0.3)
- [ ] `runStdio` export verified working (stdio.ts already exists, CI verified)
- [ ] `server.json` reviewed for correct transport and package fields
- [ ] GitHub org `WasmAgent` has permission to publish under `io.github.WasmAgent/`

---

## Update tracking table after completion

Add to `docs/distribution/upstream-prs.md`:

```markdown
| `modelcontextprotocol/registry` | CLI publish | — | ✅ **PUBLISHED** | `io.github.WasmAgent/mcp-server` |
```
