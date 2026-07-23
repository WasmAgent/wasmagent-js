# Milestones

## Milestone 1 — Core Runtime & Evidence Layer

- [ ] `@wasmagent/mcp-firewall` package with runtime firewall and policy enforcement CLI
- [ ] `@wasmagent/aep` package with signed AEP record generation after tool execution
- [ ] `@wasmagent/compliance` package with `ComplianceEvalRecord` output format
- [ ] `@wasmagent/core` package with shared-state reducer exported from `/shared-state`
- [ ] Unit tests for firewall policy engine (>80% coverage)
- [ ] Integration test for AEP signing and verification round-trip
- [ ] Trust Pack quickstart (`docs/quickstarts/trust-pack-30min.md`) with working end-to-end example
- [ ] CI pipeline with npm publish automation for all four packages

## Milestone 2 — Multi-Isolation & WASM Kernel

- [ ] WASM sandbox runtime with in-process isolation tier
- [ ] WASM sandbox runtime with process isolation tier  
- [ ] WASM sandbox runtime with VM isolation tier
- [ ] Three-tier kernel matrix with unified policy API across isolation tiers
- [ ] Language runtime host for Python (WASM bindings)
- [ ] Language runtime host for Rust (WASM bindings)
- [ ] Policy uniformity tests across all isolation tiers
- [ ] Performance benchmarks for each isolation tier (latency, throughput, memory)

## Milestone 3 — Admit Pipeline & Training Integration

- [ ] `ComplianceEvalRecord` to training data pipeline CLI (`wasmagent admit-to-dataset`)
- [ ] Dataset export format compatible with common ML frameworks (JSONL, Parquet)
- [ ] Filtering predicates for compliance threshold, date range, tool patterns
- [ ] Agent trace replay with evidence verification
- [ ] Downstream integration example: fine-tuning script for LLM training
- [ ] Audit log export for SIEM systems (syslog, JSON over HTTP)
- [ ] Compliance scoring dashboard (reference implementation)
- [ ] End-to-end test: agent run → AEP record → compliance eval → training dataset export

## Milestone 4 — Framework Embedding & Ecosystem

- [ ] LangChain integration (`@wasmagent/langchain` adapter)
- [ ] Vercel AI SDK integration (`@wasmagent/vercel-ai` adapter)
- [ ] OpenAI Agents SDK integration (`@wasmagent/openai-agents` adapter)
- [ ] Anthropic tool use integration example
- [ ] Agent ↔ UI state sync example with React reducer pattern
- [ ] Embedded runtime SDK for custom agent frameworks
- [ ] Policy composition language (DSL) for multi-framework rules
- [ ] Ecosystem documentation gallery with 5+ framework integration patterns