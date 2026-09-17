# Certified Source → Published npm Artifact Binding (`@wasmagent/aep`)

Retrospective audit for the currently-shipping AEP artifact, plus the claim
boundary that governs how this binding may be described.

**Status: binding established — no semantic source drift.**

## What was audited (2026-09-17)

| Fact | Value | Source |
|---|---|---|
| Certified JS component SHA | `93b25ba466e08d32be836e4a5e1c3c4323afd103` | `aep-certified-2026-09-16-01` (Gate C run 35051620734) |
| Package version at the certified SHA | `@wasmagent/aep` **2.9.0** | `packages/aep/package.json` at that SHA |
| Published artifact carrying current default behavior | `@wasmagent/aep` **2.10.0** | npm registry |
| npm provenance source commit | `3365307b9e2bed1f048540e254c33a4493fdecbd` | SLSA v1 provenance attestation, `resolvedDependencies[0].digest.gitCommit` |
| npm `gitHead` | `3365307b9e2bed1f048540e254c33a4493fdecbd` | registry metadata (agrees with provenance) |
| Publishing workflow | `.github/workflows/release.yml` @ `refs/heads/main` | provenance `buildDefinition.externalParameters` |
| Provenance invocation | run [35107425921](https://github.com/WasmAgent/wasmagent-js/actions/runs/35107425921) | `runDetails.metadata.invocationId` |
| Registry integrity | `sha512-2vKFTCWwWT3/n9J0noq81wIDtkkn9Lrk7EoxETL5G7qkqKzz+0gf6X3ZJsVSst1GhuZdkgkPF05fNdBb/dG7aA==` | `npm view @wasmagent/aep@2.10.0 dist.integrity` |
| Provenance subject digest | `sha512:daf2854c…dd1bb68` | provenance statement `subject[0].digest` |

Registry integrity and provenance subject digest were checked to be the same
digest (base64 vs hex encodings agree).

## Source-surface equivalence audit

Diff over the explicit AEP source surface between the certified component SHA
and the provenance source commit:

```bash
git diff 93b25ba466e08d32be836e4a5e1c3c4323afd103 \
         3365307b9e2bed1f048540e254c33a4493fdecbd \
         -- packages/aep/src packages/aep/tsconfig.json
```

**Result: empty diff** (byte-identical). The wider `packages/aep` diff over
the same range contains only:

- `packages/aep/package.json` — version bump 2.9.0 → 2.10.0
- `packages/aep/CHANGELOG.md` — release notes

…i.e. no semantic AEP source change between what Gate C certified and what
npm is serving.

## Claim boundary

Supported wording:

> `@wasmagent/aep@2.10.0` was published with npm provenance from source
> commit `3365307b`. The audited AEP source surface between certified
> component `93b25ba4` (target `aep-certified-2026-09-16-01`) and release
> source `3365307b` was byte-identical over the explicit file set
> (`packages/aep/src`, `packages/aep/tsconfig.json`).

NOT supported wording:

> ~~"the npm package `@wasmagent/aep` is certified"~~

The certified object remains the **component target** (source SHAs + Gate C
verdict), not the npm artifact. This binding is a verifiable bridge between
the two, not a transfer of certification.

## Ongoing binding

`release.yml` now emits a runtime
[`wasmagent-release-provenance/v1`](https://github.com/WasmAgent/.github/blob/main/scripts/org-contract/provenance.schema.json)
artifact per package **published by that run**, uploaded as the Actions
artifact `release-provenance` together with the pre-publish candidate
snapshot, binding `source_sha`, `workflow_sha` (release.yml content SHA),
`lock_sha256`, `toolchain`, registry `artifact_digest`, `test_run_ids`,
`publish_destination` and `outcome`.

Ownership is enforced, not implied: a snapshot taken immediately before
`changeset publish` records the workspace packages whose exact
`name@version` the registry does **not** yet serve. Only those candidates can
be attributed to the run. The generator fails closed on an empty candidate
set, a candidate still missing after publish, an artifact/candidate count
mismatch, or duplicate destinations — so a long-shipped package can never be
re-attributed to a newer release run. Future releases can additionally be
bound to the certified AEP surface by diffing against the provenance source
commit.
