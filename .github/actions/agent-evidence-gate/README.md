# WasmAgent Agent Evidence Gate (GitHub Action)

Enforce MCP tool policy and validate AEP evidence in CI — fails the build if any tool is denied.

## Quick Start

Add this step to any workflow that checks out your code:

```yaml
name: Agent Evidence Gate
on: [pull_request]

jobs:
  evidence-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Agent Evidence Gate
        uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
        with:
          tools-file: mcp-tools.json
          policy: wasmagent.policy.yaml
          fail-on-policy-violation: "true"
```

`mcp-tools.json` is the MCP server tool manifest produced by your agent runtime.
`wasmagent.policy.yaml` is your organization policy file (see [mcp-firewall README](../../../packages/mcp-firewall/README.md)).

## Full Example (All Inputs)

```yaml
name: Agent Evidence Gate — Full
on: [pull_request, push]

jobs:
  evidence-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Agent Evidence Gate
        id: gate
        uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
        with:
          policy: .wasmagent/policy.yaml
          tools-file: artifacts/mcp-tools.json
          aep-input: artifacts/agent-run.jsonl
          evidence-format: html
          evidence-output: reports/evidence-report.html
          fail-on-policy-violation: "true"
          node-version: "20"

      - name: Upload evidence report
        uses: actions/upload-artifact@v4
        with:
          name: agent-evidence
          path: reports/evidence-report.html

      - name: Print denied count
        run: echo "Denied tools: ${{ steps.gate.outputs.denied-count }}"
```

## Inputs

| Input | Description | Required | Default |
|---|---|---|---|
| `policy` | Path to `wasmagent.policy.yaml` that defines allowed/denied tool rules | No | `wasmagent.policy.yaml` |
| `tools-file` | Path to MCP tools JSON file to scan and guard against the policy | No | _(empty — scan skipped)_ |
| `aep-input` | Path to AEP evidence JSONL file to validate and export | No | _(empty — export skipped)_ |
| `evidence-format` | Evidence export format: `json` or `html` | No | `json` |
| `evidence-output` | Path to write the evidence report; defaults to `wasmagent-evidence.<format>` | No | _(auto)_ |
| `fail-on-policy-violation` | Exit with code 1 if any MCP tool is denied by policy | No | `true` |
| `node-version` | Node.js version to install for the WasmAgent CLI | No | `20` |

## Outputs

| Output | Description |
|---|---|
| `denied-count` | Number of MCP tools denied by the policy in this run |
| `evidence-path` | Absolute path to the generated evidence report file |

## Use Cases

### A. Scan MCP Tools for Security Risks in PR Checks

Prevent insecure or policy-violating MCP tool registrations from merging.

The gate runs `wasmagent scan-mcp` followed by `wasmagent guard` against your policy YAML.
It checks for injection vectors, exfiltration patterns, and sampling-abuse signatures.
If `fail-on-policy-violation` is `"true"` (the default) and at least one tool is denied,
the step exits with code 1 and the PR check fails.

```yaml
      - name: MCP Security Gate
        uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
        with:
          tools-file: mcp-tools.json
          policy: wasmagent.policy.yaml
          fail-on-policy-violation: "true"
```

The full guard report (JSON) is printed to the workflow log inside a collapsible group.
Use the `denied-count` output to drive downstream notification steps.

### B. Validate AEP Evidence JSONL (Schema + Quality Gate)

Verify that AEP records emitted by your agent runs meet schema and completeness requirements
before they are consumed by training pipelines or audit systems.

When `aep-input` is set the action runs `wasmagent evidence export` to parse and re-serialize
each record, then invokes `python3 -m evomerge validate-aep --fail-under 0.9`.
If the pass-rate is below 90% a warning annotation is added to the workflow (non-blocking by
default — set `continue-on-error: false` in a fork of this action to make it blocking).

```yaml
      - name: Validate AEP Evidence
        uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
        with:
          aep-input: agent-run.jsonl
          evidence-format: json
```

### C. Export Evidence Report as a Build Artifact

Generate a human-readable HTML or machine-readable JSON report from an AEP JSONL file and
upload it as a GitHub Actions artifact for auditing or downstream processing.

```yaml
      - name: Export Evidence Report
        id: gate
        uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
        with:
          aep-input: agent-run.jsonl
          evidence-format: html
          evidence-output: reports/evidence.html

      - name: Upload Evidence Artifact
        uses: actions/upload-artifact@v4
        with:
          name: agent-evidence-${{ github.run_id }}
          path: ${{ steps.gate.outputs.evidence-path }}
          retention-days: 30
```

The `evidence-path` output always holds the resolved file path regardless of whether
`evidence-output` was set explicitly or defaulted to `wasmagent-evidence.html`.

## Further Reading

- [mcp-firewall README](../../../packages/mcp-firewall/README.md) — policy YAML syntax,
  `wasmagent guard` CLI reference, and `MCPGateway` API
- [Trust Pack 30-Minute Quickstart](../../../docs/quickstarts/trust-pack-30min.md) — end-to-end
  walkthrough: generate a policy, run the gate locally, and wire it into CI in under 30 minutes
