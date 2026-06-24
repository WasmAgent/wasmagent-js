# @wasmagent/eliza-rollout-plugin

elizaOS community plugin that captures action runs as `rollout-wire/v1` training records (DPO/PPO-ready JSONL) for fine-tuning via [evomerge](https://github.com/WasmAgent/wasmagent-js).

elizaOS already isolates agents in a Bun Worker sandbox. This plugin does **not** add another sandbox layer — its sole purpose is the **training data loop**: capture → rank → export JSONL.

## Install

```bash
npm install @wasmagent/eliza-rollout-plugin
```

## Usage

### Zero-config (writes to `./rollouts/`)

```ts
import { createRolloutPlugin } from "@wasmagent/eliza-rollout-plugin";

export default {
  plugins: [createRolloutPlugin()],
};
```

### With evomerge HTTP sink

```ts
export default {
  plugins: [createRolloutPlugin({
    sink: { type: "http", url: "https://evomerge.example.com/ingest" },
  })],
};
```

### Multi-branch mode (enables DPO export)

```ts
export default {
  plugins: [createRolloutPlugin({
    branches: 3,       // run each action 3 times concurrently, rank, export chosen/rejected pair
    format: "both",    // write both DPO and PPO records
  })],
};
```

## Composing with `withCapabilityGovernance` (elizaOS ≥ 1.x)

elizaOS core ships `withCapabilityGovernance` in `@elizaos/core/security` — a per-call
deadline + host/path predicate layer that composes with the existing Bun Worker sandbox.
This plugin instruments the action **after** governance is applied, so you get both:

```ts
import { withCapabilityGovernance } from "@elizaos/core";
import { createRolloutPlugin } from "@wasmagent/eliza-rollout-plugin";

// Governance wraps the action first
const governed = withCapabilityGovernance(myAction, {
  allowedHosts: ["api.example.com"],
  cpuMs: 10_000,
});

// The plugin's registerAction hook then instruments the governed action for rollout capture.
// registerAction is called once per action at startup — the plugin sees the governed wrapper.
export default {
  actions: [governed],
  plugins: [createRolloutPlugin()],
};
```

The two are complementary: governance in `@elizaos/core`, training data export here.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `sink` | `FileSinkOptions \| HttpSinkOptions \| ConsoleSinkOptions` | `{ type: "file", dir: "./rollouts" }` | Where to write JSONL records |
| `format` | `"dpo" \| "ppo" \| "both"` | `"ppo"` | Export format. DPO requires `branches >= 2` |
| `branches` | `number` | `1` | Independent branches per action run. `1` = single-run mode |
| `scorer` | `(answer, task) => number` | length heuristic | Heuristic scorer for PPO reward signal (0–1) |
| `includeActions` | `string[]` | `[]` (all) | Action names to instrument. Empty = instrument all |

## Output format

Records follow the `rollout-wire/v1` schema defined in `@wasmagent/core/beta`.

### PPO record

```jsonc
{
  "prompt": "What is 2+2?",
  "completion": "four",
  "reward": 0.8,
  "tool_call_sequence": [],
  "provenance": {
    "source": "wasmagent-rollout",
    "rollout_id": "agent-123-1700000000000",
    "branch_index": 0,
    "objective_score": 1,
    "exported_at_ms": 1700000000000,
    "n_gram_hash": "52cb6b5e4a038af1"
  }
}
```

### DPO record (requires `branches >= 2`)

```jsonc
{
  "prompt": "Write a sort function",
  "chosen": "function sort(arr) { return [...arr].sort((a,b) => a-b); }",
  "rejected": "",
  "tool_call_sequence": [],
  "provenance": {
    "source": "wasmagent-rollout",
    "rollout_id": "agent-123-1700000000000",
    "chosen_branch": 0,
    "rejected_branch": 2,
    "objective_score": { "chosen": 1, "rejected": 0 },
    "exported_at_ms": 1700000000000,
    "n_gram_hash": "52cb6b5e4a038af1"
  }
}
```

## License

Apache-2.0
