---
"@wasmagent/aep": patch
---

Sort canonical-JSON keys by UTF-8 byte order instead of UTF-16 code-unit order, matching the Rust verifier's `serde_json::Map` (BTreeMap) ordering. Records whose extra fields contain astral-plane keys (e.g. `"𐀀"` next to `"Ａ"`) previously produced canonical bytes that a Rust verifier would order differently, so cross-language signature verification failed closed. Records with ASCII or plain-BMP keys are byte-for-byte unchanged.
