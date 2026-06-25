# WasmAgent Edition Strategy

## Public Edition (open-source, this repo)

Everything in this repository is the Public Edition. It includes:

- **Runtime**: `@wasmagent/core`, all kernels, all model adapters
- **MCP layer**: `@wasmagent/mcp-server`, `@wasmagent/mcp-firewall`, `@wasmagent/mcp-gateway`, `@wasmagent/mcp-policy`, `@wasmagent/mcp-attestation`
- **Evidence protocol**: `@wasmagent/aep`
- **OTel**: `@wasmagent/otel-exporter`
- **Compliance**: `@wasmagent/compliance`
- **Benchmark adapters**: `trace-pipeline` benchmark adapters (BFCL v4, MCP-Atlas, Terminal-Bench, τ-bench, ToolSandbox, AgentHarm)
- **Examples**: All recipe* demos including recipe17 end-to-end demo
- **WASM Component ABI**: WIT definitions in `packages/wit/`

## Research Edition (private, not in this repo)

The Research Edition extends the Public Edition with:

- **Private bscode tasks**: 22+ task manifests with hidden specs (not published to avoid contamination)
- **Compliance-conditioned model training**: SFT/DPO training pipelines on proprietary compliance traces
- **Proprietary traces**: Agent execution traces from internal deployments
- **Unpublished benchmark audit results**: Full benchmark linter results before public release
- **Enterprise receipts**: Run receipts from production deployments with operator signatures
- **Router training data**: GBDT/XGBoost router models trained on private compliance records

## Boundary rules

1. Any new algorithm or protocol MUST land in the Public Edition first.
2. Private data (traces, tasks, model weights) stays in Research Edition.
3. Papers cite Public Edition artifacts; Research Edition data provides the experimental substrate.
4. The `ComplianceEvalRecord` schema is the boundary: records may be private, but the schema is public.
