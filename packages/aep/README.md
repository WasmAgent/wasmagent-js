# @wasmagent/aep

> **Maturity: beta (v0.3 schema)** — AEP v0.3 extends the evidence schema with side-effect classification, state-digest metadata, argument-drift detection, and approval-mode semantics. The Ed25519 signature contract remains stable from v0.2. The signing key management story (KMS rotation, key revocation) is still evolving; treat key-id semantics as beta-stable.

Agent Evidence Protocol — runtime action evidence and run provenance types for WasmAgent.

Emit verifiable `AEPRecord` evidence after every agent run. Records are schema-versioned; v0.3 is the current shipped schema. v0.1 and v0.2 records are still parsed for backward compatibility but no longer produced. Records are consumable by `evomerge` for audit and training data export.

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

## Factory / Builder API

Use `AEPEmitter.withDefaults()` to create a factory that shares common options across many emitters (useful in long-lived services that emit one record per request):

```ts
import { AEPEmitter } from "@wasmagent/aep";

// Create once at service boot
const factory = AEPEmitter.withDefaults({
  model_id: "claude-sonnet-4-6",
  model_provider: "anthropic",
  repo_commit: process.env.GIT_COMMIT,
  runtime_version: process.env.AGENT_VERSION,
  recordingMode: "full",
});

// Per-request — only supply the run-specific fields
const emitter = factory.create({ run_id: crypto.randomUUID() });
emitter.addAction({ tool_name: "search", state_changing: false });
const record = emitter.build();
```

Overrides passed to `factory.create()` take precedence over the shared defaults.

## Compliance fields for run-provenance traceability

`AEPRecord` v0.2 carries four optional string fields whose intent is to anchor an emitted record back to the exact code, runtime, policy ruleset, and tool manifest that produced it:

| Field | Meaning | Typical source |
|---|---|---|
| `repo_commit` | Git commit hash of the agent code at run time | `process.env.GIT_COMMIT`, or `git rev-parse HEAD` captured at boot |
| `runtime_version` | Agent runtime version string | `process.env.AGENT_VERSION`, or `package.json#version` read at boot |
| `policy_bundle_digest` | SHA-256 of the active policy ruleset bundle | Computed when the bundle is loaded (boot, or on hot-reload) |
| `tool_manifest_digest` | SHA-256 of the declared tool manifest | Computed when the manifest is loaded |

All four are `optional` on the schema (`packages/aep/src/types.ts`). The constructor of `AEPEmitter` already accepts them — there is no API change required to start populating them:

```ts
import { createHash } from "node:crypto";
import { AEPEmitter } from "@wasmagent/aep";

function digestOf(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const emitter = new AEPEmitter({
  run_id: "run-001",
  model_id: "claude-sonnet-4-6",
  model_provider: "anthropic",
  // Captured once at process boot / build time; reused across all records.
  repo_commit: process.env.GIT_COMMIT,
  runtime_version: process.env.AGENT_VERSION,
  // Computed once when the bundle / manifest is loaded.
  policy_bundle_digest: digestOf(policyBundleCanonicalBytes),
  tool_manifest_digest: digestOf(toolManifestCanonicalBytes),
  signer,
});
```

### When to populate

| Field | When to compute |
|---|---|
| `repo_commit` | CI build (baked in as `GIT_COMMIT` env), or `git rev-parse HEAD` once at process start. Stable for the lifetime of the deployed process. |
| `runtime_version` | Read from `package.json` at process start, or injected via `AGENT_VERSION`. Stable per release. |
| `policy_bundle_digest` | When the policy ruleset is loaded — at boot, and again after any hot-reload. Recompute the digest if the bundle changes mid-process. |
| `tool_manifest_digest` | When the tool manifest is loaded. Same lifecycle as the policy bundle. |

### How to compute the digests

Use SHA-256 over the canonical byte representation of the bundle/manifest file set. For a single JSON manifest, that's `createHash('sha256').update(JSON.stringify(canonical))`. For multi-file bundles, hash a stable concatenation (e.g. sort entries by path, then `hash(path + "\0" + content)` per entry).

The exact canonicalisation is not prescribed by the schema — what matters is that the same logical bundle always produces the same digest, and that consumers downstream can recompute it independently from the artefact on disk.

### Why these fields are worth populating

Each field maps to one or more traceability requirements that downstream audit, eval, and replay tools expect. The mapping below is **informational**: AEP records do not by themselves satisfy any legal compliance obligation, and `@wasmagent/aep` makes no certification claim.

Fields aligned with traceability requirements such as:
- **EU AI Act (Regulation (EU) 2024/1689)** — Art. 12(3)(c) (system change documentation), Art. 19 (automatic logging enabling traceability), Annex IV Item 1(a) (provider and system version) and Item 6 (lifecycle changes).
- General agent-system auditability — replaying a run requires knowing the exact code, runtime, policy, and tool definitions in effect.

Whether a given deployment's records *meet* any specific regulatory requirement depends on retention policy, signing-key management, downstream review workflow, and the legal interpretation that applies to the operator — none of which `@wasmagent/aep` enforces.

## Resolving `repo_commit` automatically

The `resolveRepoCommit()` helper resolves the current repo commit using a three-step fallback chain:

1. Environment variable (default: `AEP_REPO_COMMIT`)
2. `git rev-parse HEAD` in the working directory
3. `package.json` version (prefixed with `v`)

```ts
import { AEPEmitter, resolveRepoCommit } from "@wasmagent/aep";

const emitter = new AEPEmitter({
  run_id: "run-001",
  repo_commit: resolveRepoCommit(),
});
```

Customise the env var name or working directory:

```ts
resolveRepoCommit({
  envVar: "GIT_COMMIT",          // default: "AEP_REPO_COMMIT"
  cwd: "/app",                   // default: process.cwd()
  fallbackToVersion: false,      // default: true
});
```

## Documentation

- [AEP schema](./src/types.ts)
- [wasmagent-js security pack](https://WasmAgent.github.io/wasmagent-js/security-governance-pack/)
- [trace-pipeline evomerge](https://github.com/WasmAgent/trace-pipeline)

## Recording Modes

Each `ActionEvidence` entry carries a `recording_mode` field that controls how much content is captured:

| Mode | Meaning | When to use |
|---|---|---|
| `validation` | Digests only — hash of inputs/outputs, no raw content. Minimal storage, sufficient for tamper detection. | Default. Read-only actions with no anomaly signals. |
| `delta` | Captures a diff/patch relative to a prior state referenced by `delta_ref`. | Local mutations (file edits, DB updates) where full snapshots are wasteful. |
| `full` | Captures complete input and output content alongside digests. | High-risk actions: external mutations, network egress, tainted inputs, consent anomalies, unknown side-effects. |

The mode defaults to `"validation"` for backwards compatibility with v0.2 records that omit the field.

### Setting the recording mode

```ts
// Emitter-level default (applies to all actions unless overridden)
const emitter = new AEPEmitter({ run_id: "run-001", recordingMode: "full" });

// Per-action override
emitter.addAction({
  tool_name: "patch_file",
  state_changing: true,
  recording_mode: "delta",
  delta_ref: "sha256:previous-state-digest",
});
```

The `delta_ref` field is only meaningful when `recording_mode` is `"delta"` — it references the prior state snapshot the delta is computed against.

## v0.3 Schema Additions

AEP v0.3 introduces four new capabilities to the evidence schema:

### Side-Effect Classification (Gap 1)

Each `ActionEvidence` carries a `side_effect_class` field that classifies the impact of the action:

| Class | Meaning |
|---|---|
| `read` | Read-only, no mutation |
| `mutate-local` | Local state change (file edit, DB write) |
| `mutate-external` | External system mutation (deploy, API call) |
| `network-egress` | Outbound network traffic |
| `unknown` | Not yet classified (default) |

The top-level `AEPRecord` also carries `run_side_effect_class_max` — the highest severity class across all actions in the run, computed automatically by the emitter.

```ts
emitter.addAction({
  tool_name: "deploy",
  state_changing: true,
  side_effect_class: "mutate-external",
});
```

### State Digest Metadata (Gap 2)

When `pre_state_digest` or `post_state_digest` is present, you can annotate it with:

- `state_digest_kind` — identifies what is being digested (`"git-tree"`, `"sandbox-fs"`, `"db-rowset"`, `"browser-dom"`, `"kv-snapshot"`, `"memory-bag"`, `"other"`)
- `state_digest_coverage` — a free-form record describing the scope of the digest

```ts
emitter.addAction({
  tool_name: "git_commit",
  state_changing: true,
  pre_state_digest: "sha256:abc",
  post_state_digest: "sha256:def",
  state_digest_kind: "git-tree",
  state_digest_coverage: { paths: ["/src"], depth: 3 },
});
```

### Argument Drift Detection (Gap 3)

Detects when observed tool arguments differ from approved arguments:

```ts
emitter.addAction({
  tool_name: "exec_command",
  state_changing: true,
  argument_drift: {
    detected: true,
    approved_args_digest: "sha256:approved",
    observed_args_digest: "sha256:observed",
    resolution: "denied",
  },
});
```

### Approval Mode and Extensions (Gap 4)

`CapabilityDecision` now carries approval semantics:

- `approval_mode` — how the decision was reached (`"one-shot-payload"`, `"bounded-lease"`, `"policy-allow-with-receipt"`, `"policy-deny-with-evidence"`, `"re-approval-on-drift"`, `"none"`)
- `approval_extension` — namespace-scoped extension evidence
- `deny_reason_class` — why a deny occurred (`"tool-identity"`, `"argument"`, `"tainted-input"`, `"resource-scope"`, `"missing-delegation"`, `"policy-rule"`, `"other"`)

```ts
emitter.addCapabilityDecision({
  capability: "fs:write",
  subject: "agent",
  resource: "/tmp/out.txt",
  decision: "deny",
  approval_mode: "policy-deny-with-evidence",
  deny_reason_class: "resource-scope",
});
```

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

The four provenance fields described in [Compliance fields for run-provenance traceability](#compliance-fields-for-run-provenance-traceability) (`repo_commit`, `runtime_version`, `policy_bundle_digest`, `tool_manifest_digest`) are part of the signed payload when populated — tampering with them invalidates the signature exactly the same way mutating `run_id` does.

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
