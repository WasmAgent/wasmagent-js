# @wasmagent/mcp-posture

MCP attack-surface posture snapshot validator and drift analyzer.

Part of the [WasmAgent](https://github.com/WasmAgent/wasmagent-js) runtime monorepo. **Alpha** — the schema is versioned and fields may be added without a breaking-change bump; the package is not yet published to npm.

## What it does

- Validates MCP server posture snapshots against `@wasmagent/protocol` schemas: risk categories, session model (`stateful` / `stateless-handle` / `unknown`), auth shape, and handle expiry policy.
- Produces posture diffs (`createPostureDiff`) between two snapshots so drift — new capabilities, changed auth modes, expired handles — becomes a reviewable artifact instead of a surprise.

## Usage

```ts
import { createPostureDiff } from "@wasmagent/mcp-posture";

const diff = createPostureDiff({ previous, current });
if (!diff.isEmpty) {
  // surface added/removed/changed entries for review
}
```

See `src/index.ts` for the full `ValidationResult`, `RiskCategory`, `McpPostureAuth`, and `PostureDiff` shapes — that file is the source of truth while the API is alpha.

## Relationship to other packages

| Concern | Package |
|---|---|
| Policy enforcement at tool-call time | `@wasmagent/mcp-firewall` / `@wasmagent/mcp-gateway` |
| Capability attestations | `@wasmagent/mcp-attestation` |
| Schema definitions | `@wasmagent/protocol` |

Per the repository ownership matrix (AGENTS.md), the AgentBOM / MCP Posture / Trust Passport *specifications* live in `agent-trust-infra`; this package implements the validation/diff mechanics for this runtime.

## License

Apache-2.0
