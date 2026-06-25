# @wasmagent/aep

> **Maturity: alpha** — may change without notice; production use at your own risk.

Agent Evidence Protocol — runtime action evidence and run provenance types for WasmAgent.

Emit verifiable `AEPRecord` evidence after every agent run. Records are schema-versioned (`aep/v0.1`) and consumable by `evomerge` for audit and training data export.

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

## License

Apache-2.0
