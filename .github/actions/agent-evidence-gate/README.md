# WasmAgent Agent Evidence Gate

GitHub Action that runs MCP Guard and exports AEP evidence in CI.

## Usage

```yaml
name: Agent Evidence Gate
on: [pull_request]

jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run WasmAgent Guard
        uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
        with:
          policy: wasmagent.policy.yaml
          tools-file: tools.json
          fail-on-policy-violation: "true"
```

## Inputs

| Input | Description | Default |
|---|---|---|
| `policy` | Path to `wasmagent.policy.yaml` | `wasmagent.policy.yaml` |
| `tools-file` | MCP tools JSON to scan | — |
| `aep-input` | AEP evidence JSONL to validate/export | — |
| `evidence-format` | `json` or `html` | `json` |
| `evidence-output` | Output path for evidence report | `wasmagent-evidence.<fmt>` |
| `fail-on-policy-violation` | Exit 1 if any tool denied | `true` |

## Outputs

| Output | Description |
|---|---|
| `denied-count` | Number of tools denied by policy |
| `evidence-path` | Path to the generated evidence report |

## What it does

1. **Scans** your MCP tools JSON for injection, exfiltration, and sampling abuse patterns
2. **Enforces** your policy YAML — fails CI if any tool is denied
3. **Exports** AEP evidence as JSON or HTML report
4. **Validates** AEP records meet evidence completeness threshold

## Example with evidence export

```yaml
      - name: Run WasmAgent Evidence Gate
        uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
        with:
          tools-file: mcp-tools.json
          aep-input: agent-run.jsonl
          evidence-format: html
          evidence-output: evidence-report.html

      - name: Upload evidence
        uses: actions/upload-artifact@v4
        with:
          name: agent-evidence
          path: evidence-report.html
```
