# WasmAgent Security Benchmark Runner

A standalone benchmark that exercises the `vetTool` static analysis layer from
`@wasmagent/mcp-firewall` against 10 representative MCP attack scenarios.

## What it does

The runner defines 10 attack scenarios drawn from the OWASP MCP Top 10 threat
taxonomy. Each scenario supplies a crafted MCP tool descriptor containing one or
more attack vectors:

| Vector | Detection rule | Expected outcome |
|---|---|---|
| Prompt injection / override instructions | `INJECTION_PATTERNS` → deny | `block` |
| Credential / secret exfiltration | `EXFILTRATION_PATTERNS` → ask | `ask_user` |
| LLM sampling abuse | `SAMPLING_PATTERNS` → ask | `ask_user` |
| Invisible Unicode steganography | `INVISIBLE_CHAR_RE` → ask | `ask_user` |

For each scenario the runner:

1. Calls `vetTool(toolEntry)` and receives a `VettingResult`.
2. Maps the result to an outcome string: `block`, `ask_user`, `flag`, or `allow`.
3. Compares the actual outcome to the expected outcome.
4. Prints a colour-coded results table.

## Prerequisites

Build the monorepo once before running:

```bash
# From the repo root
npm run build
```

## How to run

```bash
# From the repo root
node examples/security-benchmark/run.mjs
```

## Expected output

```
╔══════════════════════════════════════════════════════════════╗
║   WasmAgent — Security Benchmark (10 scenarios)              ║
╚══════════════════════════════════════════════════════════════╝

  ID              Scenario                                          Expected  Actual    Result
  ────────────────────────────────────────────────────────────────────────────────────────────
  ✓ bench-01      Prompt Injection Override                         block     block     PASS
  ✓ bench-02      Credential Harvesting                             ask_user  ask_user  PASS
  ...
  ────────────────────────────────────────────────────────────────────────────────────────────
  10/10 scenarios passed — static vetting layer verified.
```

## Exit codes

| Exit code | Meaning |
|---|---|
| `0` | All 10 scenarios passed |
| `N` (1–10) | N scenarios produced an unexpected outcome |
| `1` (special) | `@wasmagent/mcp-firewall` could not be loaded (run `npm run build` first) |

## Relationship to the OWASP demo

`examples/owasp-demo/run-demo.mjs` is the full OWASP-labelled demo with AEP
field references. This benchmark is a leaner correctness harness — no scenario
labels, no AEP annotations — suitable for CI regression testing of the vetting
layer in isolation.
