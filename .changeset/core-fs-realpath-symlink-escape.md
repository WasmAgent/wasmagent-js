---
"@wasmagent/core": patch
---

Use realpath-aware containment in assertPathAllowed to prevent symlink escape from allowed read/write paths. Previous lexical-only check could be bypassed by a symlink inside an allowed prefix pointing outside.
