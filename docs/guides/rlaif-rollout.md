# RLAIF Rollout Pipeline

> **Status:** shipped 2026-06-22. All primitives exported from `@wasmagent/core`.

wasmagent-js provides a complete pipeline for generating RLAIF (Reinforcement
Learning from AI Feedback) training data from live agent trajectories. The
pipeline connects three projects: **wasmagent-js** (SDK primitives),
**bscode** (bscode adapter for objective B2/C3 signals), and **evomerge**
(training data export + validation).

---

## Quick overview

```
RolloutForkRunner          ← forks ToolCallingAgent × N branches
    ↓ RolloutBranchResult[]
BuildPassesVerifier        ← exitCode=0 → objective_score=1
VisualAssertVerifier       ← visual.verdict=pass → objective_score=1
    ↓ scores[]
RolloutRanker              ← Bradley-Terry + ScalarLLMJudgeVerifier pairwise
    ↓ RankedBranch[]
RolloutMemoryStore         ← persist top branches for future sampling
    ↓ JSONL
evomerge TrainingDataExporter ← DPO pairs + PPO rewards
```

---

## RolloutForkRunner

Fork a `ToolCallingAgent` run across N independent branches. Each branch runs
the full tool-call loop and yields its complete `AgentEvent[]` trajectory.

```ts
import { RolloutForkRunner } from "@wasmagent/core";

const runner = new RolloutForkRunner({
  branches: 5,
  concurrency: 5,
  temperaturePerBranch: [0.5, 0.6, 0.7, 0.8, 0.9],
  // For stateful test mocks: provide a fresh model per branch
  // modelFactory: () => new AnthropicModel("claude-sonnet-4-6", apiKey),
});

for await (const result of runner.run(agentOpts, "Build a REST endpoint")) {
  console.log(result.branchIndex, result.finalAnswer, result.toolCallSequence);
  // result.buildResult is null — filled by verifiers below
}
```

`tool_result` outputs in `toolCallSequence` are automatically passed through
`summarizeToolOutput()` before persistence. Training data and inference context
always see the same compressed form.

### Key fields in RolloutBranchResult

| Field | Type | Notes |
|---|---|---|
| `rolloutId` | `string` | Shared across all branches in one `run()` call |
| `branchIndex` | `number` | 0..N-1 |
| `sessionId` | `string` | Derived via `<prefix>-b<index>-<uuid>` |
| `trajectory` | `AgentEvent[]` | Full event stream from run_start to final_answer |
| `toolCallSequence` | `AgentEvent[]` | `tool_call` + `tool_result` only, outputs summarized |
| `finalAnswer` | `string` | Text from the `final_answer` event |
| `buildResult` | `null` | Filled externally by the bscode adapter |

---

## BuildPassesVerifier / VisualAssertVerifier

Objective signal verifiers for `VerificationPipeline`. Both accept an injected
callback so `@wasmagent/core` stays decoupled from bscode's KV channel.

**Critical invariant:** `status === "running"` and `status === "unknown"` always
fail — they never default to pass.

```ts
import { BuildPassesVerifier, VisualAssertVerifier, VerificationPipeline } from "@wasmagent/core";
// bscode-specific adapter:
import { makeBuildResultReader, makeVisualResultReader } from "bscode/rollout-adapter";

const pipeline = new VerificationPipeline({
  ws: myWorkspaceReader,
  verifiers: [
    new BuildPassesVerifier({ getBuildResult: makeBuildResultReader(kv) }),
    new VisualAssertVerifier({ getVisualResult: makeVisualResultReader(kv) }),
  ],
});

const result = await pipeline.run([
  { id: "build", description: "build passes", verify_method: "build_passes", arg: sessionId },
  { id: "visual", description: "renders correctly", verify_method: "visual_assert", arg: sessionId },
]);
```

---

## ToolOutputSummarizer

Deterministic head+tail truncation. Use before storing tool outputs in training
data **and** before passing to the model — both must see the same form.

```ts
import { summarizeToolOutput } from "@wasmagent/core";

const compressed = summarizeToolOutput(rawStderr, {
  maxBytes: 800,       // default
  keepFirstLines: 3,   // default
  keepLastLines: 5,    // default
});
// Short outputs returned verbatim. Long outputs: first 3 lines + [...N omitted...] + last 5 lines.
```

---

## ScalarLLMJudgeVerifier

Extends `LLMJudgeVerifier`'s reward-hacking defences with scalar scoring and
pairwise comparison. Used internally by `RolloutRanker`; can also be used standalone.

```ts
import { ScalarLLMJudgeVerifier } from "@wasmagent/core";

const judge = new ScalarLLMJudgeVerifier({
  model: judgeModel,          // use a separate model from the executing agent
  samples: 3,                 // k-of-N: 3 independent judge calls
  temperature: 0.1,           // low temperature, adversarial default
  maxJudgeCallsPerBatch: 100, // cap — excess samples get neutral score 5
});

// Score mode (Verifier interface)
const verdict = await judge.verify(criterion, workspaceReader);
// verdict.ok === true → verdict.score is 0-10

// Pairwise mode
const { preferred, reasoning } = await judge.comparePair({
  criterionDescription: "code quality and correctness",
  outputA: branchA.finalAnswer,
  outputB: branchB.finalAnswer,
});
```

---

## KernelPool

Bounded concurrency pool for `WasmKernel` instances. One pool per rollout
batch; each branch acquires a kernel slot by rollout ID.

```ts
import { KernelPool } from "@wasmagent/core";
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote";

const pool = new KernelPool({
  factory: () => new RemoteSandboxKernel({ apiKey: process.env.E2B_API_KEY }),
  maxConcurrent: 16,
});

const kernel = await pool.acquire("rollout-id-abc");
const result = await kernel.runCommand("npm install");
await pool.release("rollout-id-abc");

await pool[Symbol.asyncDispose](); // clean up all kernels
```

---

## RolloutRanker

Ranks N branches by objective score + judge pairwise comparison.

```ts
import { RolloutRanker } from "@wasmagent/core";

const ranker = new RolloutRanker({
  judge,                       // ScalarLLMJudgeVerifier
  judgeCriterion: "overall quality and correctness",
  rewardFunctions: [
    { key: "objective", weight: 1.0, score: r => r.objectiveScore },
    { key: "judge",     weight: 0.3, score: r => (r.judgeScore ?? 5) / 10 },
  ],
});

const { ranked, stats } = await ranker.rank(records);
// ranked[0] is the best branch
// stats.powered: false when n < 10 — result is inconclusive
```

The report always includes `powered: boolean` and `minDetectableDeltaPp`.
When `powered === false`, treat the ranking as a best-effort estimate, not
a statistically significant claim.

---

## RolloutMemoryStore

Persist high-quality branch experiences for future sampling. Only
`objectiveScore === 1` branches are stored; score-0 branches are silently
discarded to prevent poisoning.

```ts
import { RolloutMemoryStore } from "@wasmagent/core";
import { InMemoryVectorStore } from "@wasmagent/core"; // or Pinecone/Qdrant

const store = new RolloutMemoryStore({ store: retriever });

// After ranking — store the winning branch
await store.upsert({ rolloutId, branchIndex, task, keySteps, objectiveScore: 1, finalAnswer });

// Before the next fork batch — inject relevant past experience
const memories = await store.retrieve(task, 3);
const injection = RolloutMemoryStore.formatAsSystemPrompt(memories);
// Prepend `injection` to the system prompt in agentOpts
```

---

## End-to-end example

```ts
import {
  RolloutForkRunner,
  RolloutRanker,
  RolloutMemoryStore,
  KernelPool,
  ScalarLLMJudgeVerifier,
  BuildPassesVerifier,
} from "@wasmagent/core";
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote";
import { makeBuildResultReader } from "bscode/rollout-adapter";

// 1. Fork N branches
const runner = new RolloutForkRunner({ branches: 8, concurrency: 8 });
const results = [];
for await (const r of runner.run(agentOpts, task)) results.push(r);

// 2. Score with objective signal
const verifier = new BuildPassesVerifier({ getBuildResult: makeBuildResultReader(kv) });
for (const r of results) {
  const v = await verifier.verify(
    { id: "build", description: "build passes", verify_method: "build_passes", arg: r.sessionId },
    ws
  );
  r.objectiveScore = v.ok ? 1 : 0;
}

// 3. Rank
const judge = new ScalarLLMJudgeVerifier({ model: judgeModel });
const ranker = new RolloutRanker({ judge });
const { ranked, stats } = await ranker.rank(results);

// 4. Store winners for next round
const memStore = new RolloutMemoryStore({ store: retriever });
for (const r of results.filter(r => r.objectiveScore === 1)) {
  await memStore.upsert({ ...r, keySteps: r.toolCallSequence.map(e => e.data?.toolName).join(" → ") });
}

// 5. Export to evomerge
// python -m datafactory.exporter --input rollouts.jsonl --output-dpo dpo.jsonl --output-ppo ppo.jsonl
```

---

## Statistical discipline

Every ranking report includes:

- `powered: boolean` — False when `n < 10` or Wilson CI half-width ≥ 30pp.
- `minDetectableDeltaPp` — minimum detectable pass-rate difference.
- `mcnemarP` — McNemar exact test p-value on top/bottom halves (null when n < 4).

When `powered === false`, the ranking is a heuristic estimate.
Only treat rankings as evidence when `powered === true` and `mcnemarP < 0.05`.
