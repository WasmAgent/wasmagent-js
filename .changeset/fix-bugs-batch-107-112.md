---
"@wasmagent/core": patch
---

fix: batch bug fixes (#107, #111, #112, #117, #119)

- #107: ApprovalPolicy path matching no longer uses overly broad prefix (e.g. 'submit' no longer matches 'submit_pr')
- #111: ObservationalMemory.noteStep() buffers calls during background passes instead of silently dropping them
- #112: ToolCallingAgent final_answer event always serializes answer to string and includes a `type` field for SSE consumers
- #117: ToolCallingAgent.run() no longer unconditionally resets the assembler when pre-injected history exists
- #119: FileStructuredKv uses an async mutex to serialize write operations, preventing concurrent write corruption
