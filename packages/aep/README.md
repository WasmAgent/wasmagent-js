# @wasmagent/aep

> **Maturity: beta (v0.2 signature contract)** — AEP v0.2 Ed25519 signature contract shipped and schema-versioned. The signing key management story (KMS rotation, key revocation) is still evolving; treat key-id semantics as beta-stable.

Agent Evidence Protocol — runtime action evidence and run provenance types for WasmAgent.

Emit verifiable `AEPRecord` evidence after every agent run. Records are schema-versioned; v0.2 (Ed25519 signature contract) is the current shipped schema. v0.1 records are still parsed for backward compatibility but no longer produced. Records are consumable by `evomerge` for audit and training data export.

## Install

```bash
npm install @wasmagent/aep
```

## Usage

```ts
import { AEPEmitter } from "@wasmagent/aep";

const emitter = new AEPEmitter({
  run_id: "run-001",
  model_id: "claude-sonnet-4-6",
  model_provider: "anthropic",
});

// During the run — record tool call evidence
emitter.addAction({
  tool_name: "bash",
  state_changing: false,
  result_digest: "sha256-abc...",
  timestamp_ms: Date.now(),
});

// At the end — build the signed evidence record
const record = emitter.build();
// record satisfies AEPRecord (aep/v0.1)
```

## Documentation

- [AEP schema](./src/types.ts)
- [wasmagent-js security pack](https://WasmAgent.github.io/wasmagent-js/security-governance-pack/)
- [trace-pipeline evomerge](https://github.com/WasmAgent/trace-pipeline)

## Signature contract v0.2

Every `AEPRecord` emitted via `AEPEmitter.emit()` carries a mandatory `signature` block:

```ts
signature: {
  alg: "ed25519",   // always "ed25519" in v0.2
  key_id: string,   // stable identifier for the signing key (e.g. "local-dev-key-01")
  sig: string,      // base64-encoded 64-byte Ed25519 signature
}
```

### What is signed

The signature covers the **canonical serialisation** of the record minus the `signature` field itself.
Canonical serialisation sorts JSON object keys lexicographically (recursive) and UTF-8-encodes the result.
This means any field mutation (including `run_id`, `created_at_ms`, `actions`, etc.) invalidates the signature.

### Verifying a record

```ts
import { verifyAEPRecord, createLocalSignerFromSeed } from "@wasmagent/aep";

const signer = createLocalSignerFromSeed(seedHex, "my-key-01");
const publicKey = await signer.getPublicKey();

const valid = await verifyAEPRecord(record, publicKey);  // true / false
```

### KMS adapter interface

To swap in a hardware KMS (AWS KMS, GCP Cloud KMS, HashiCorp Vault, etc.) implement the `AEPSigner` interface:

```ts
export interface AEPSigner {
  readonly keyId: string;
  sign(bytes: Uint8Array): Promise<string>;  // returns base64-encoded signature
}
```

Example skeleton for AWS KMS (not included in this package — bring your own SDK):

```ts
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";

class AwsKmsSigner implements AEPSigner {
  constructor(readonly keyId: string, private client: KMSClient) {}

  async sign(bytes: Uint8Array): Promise<string> {
    const resp = await this.client.send(new SignCommand({
      KeyId: this.keyId,
      Message: bytes,
      MessageType: "RAW",
      SigningAlgorithm: "ECDSA_SHA_256",  // use the algorithm supported by your key
    }));
    return Buffer.from(resp.Signature!).toString("base64");
  }
}
```

Pass any `AEPSigner` implementation to `AEPEmitter`:

```ts
const emitter = new AEPEmitter({ run_id: "run-001", signer: new AwsKmsSigner(keyId, kmsClient) });
const record = await emitter.emit();
```

## License

Apache-2.0
