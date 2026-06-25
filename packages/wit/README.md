# WasmAgent WASM Component Plugin ABI

This directory contains the WIT (WebAssembly Interface Type) definitions for
WasmAgent's WASM Component Plugin ABI (P1-1).

## Overview

WIT is the standard interface definition language for the WebAssembly Component
Model. These definitions allow third-party policy and verifier components to be
implemented in any language that compiles to WASM (Rust, C, C++, Go, Python via
Componentize-py, etc.) and loaded at runtime without any language-specific FFI.

## Interfaces

| Interface   | Purpose |
|-------------|---------|
| `policy`    | Policy enforcement — check whether a subject/action/resource triple is allowed |
| `verifier`  | Claim verification — evaluate claims against evidence, return scored verdicts |
| `redactor`  | Text redaction — apply a named profile to strip PII or secrets |
| `evidence`  | AEP evidence emission — emit action and verifier records to the AEP stream |

## World

`wasmagent-runtime` is the top-level component world:
- **imports** `policy`, `verifier`, `redactor` — the host provides these
- **exports** `evidence` — the guest component must implement this

## Usage

Compile your component against `wasmagent.wit` and load it via the WasmAgent
runtime plugin loader (see `packages/kernel-wasmtime/` for the host-side loader).

```wit
// Example: a minimal Rust component implementing the evidence export
// See https://component-model.bytecodealliance.org for toolchain docs
```

## Future work

- Integrate with wasmCloud lattice for distributed plugin deployment
- WASI 0.3 async streams for non-blocking evidence emission
- Wasmtime typed-function interface (component-model/wasm-tools)
- Sigstore-signed component bundles for attestation chain
