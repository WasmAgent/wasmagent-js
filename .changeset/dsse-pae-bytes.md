---
"@wasmagent/aep": minor
---

DSSE PAE now covers decoded serialized-body bytes (not base64 text), conforming to DSSE 1.0 §2. `paeEncode` accepts `Uint8Array` payload; `paeEncodeString` added for convenience. All existing signatures must be regenerated.
