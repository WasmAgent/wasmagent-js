---
"@wasmagent/cli": patch
---

Handle Bun 1.3.11 mkdir(".") EEXIST behavior on Windows by guarding with existsSync before mkdir, and switch tests to use mkdtempSync to avoid the divergence.
