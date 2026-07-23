---
"@wasmagent/mcp-firewall": minor
---

feat(mcp-firewall): detect descriptor mutation (rug-pull) in vetTool() (#168)

- `vetTool()` accepts an optional `baseline` `ToolDescriptorSnapshot` (produced by `snapshotTool()` from `@wasmagent/mcp-server`). When supplied, it emits a `rug_pull` finding (`category`/`type` `rug_pull`, severity `high`, recommendation `ask`) for every descriptor field whose SHA-256 hash has drifted since first-seen — flagging the tool for re-review even when the new descriptor itself looks benign.
- Completes the third static risk class for the MCP Firewall milestone: prompt injection, data exfiltration, and descriptor mutation risks.
- `VetToolOptions` gains an optional `baseline` field and `vetToolAsync()` propagates it into the synchronous phase. Fully backward compatible: with no baseline supplied, `vetTool()` behaves exactly as before (no `rug_pull` findings).
