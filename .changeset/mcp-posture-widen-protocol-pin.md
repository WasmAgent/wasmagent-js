---
"@wasmagent/mcp-posture": patch
---

Widen the `@wasmagent/protocol` dependency from the exact pin `0.1.7` to `^0.1.9`. The exact pin forced bun/npm to nest a second 0.1.7 copy inside every consumer that had already moved to 0.1.9 (observed in agentbom's lockfile), defeating dedupe and freezing consumers on the pre-attribution canonical schema.
