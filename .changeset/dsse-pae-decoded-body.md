---
"@wasmagent/aep": minor
---

DSSE PAE now covers decoded serialized-body bytes per DSSE 1.0.2 §2 (was: base64 text). `paeEncode` accepts `Uint8Array`. All existing DSSE signatures must be regenerated.
