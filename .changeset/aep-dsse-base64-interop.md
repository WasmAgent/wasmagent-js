---
"@wasmagent/aep": minor
---

DSSE 1.0.2 base64 verifier interop + current-profile signed-record schema.

- `verifyDSSEEnvelope` / `verifyAEPRecord` now accept both standard and
  URL-safe base64 alphabets for the envelope payload and signature ("Either
  standard or URL-safe base64 encodings are allowed ... verifiers MUST accept
  either"), decoding via a bijection ('-'→'+', '_'→'/') that matches the Rust
  and Python verifiers byte-for-byte, including unique decoding of mixed
  alphabets.
- New `decodeBase64Either` export with the same semantics.
- New `AEPDSSESignedRecordSchema`: the structural presence shape for
  current-profile signed evidence (requires `dsse_envelope` + mirror
  `signature`). `AEPSignedRecordSchema` is retained as a deprecated alias of
  the renamed `AEPRecordWithSignatureMetadataSchema` — carrying the inline
  signature block alone is compatibility metadata, not a current-profile
  signed record. Cryptographic verification remains the domain of
  `verifyAEPRecord` / `verifyDSSEEnvelope`.
