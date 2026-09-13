---
"@wasmagent/kernel-wasmtime": minor
---

`maxMemoryBytes` is now validated as a hard ceiling: non-finite, non-safe-integer, non-positive, or sub-page (< 65536 bytes) values throw a `RangeError` at construction. WebAssembly memory is page-granular, so a sub-page limit cannot be enforced — the previous behavior silently widened it to one page, contradicting the hard-maximum contract.
