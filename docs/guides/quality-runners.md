# Quality Runners

### Self-Consistency — majority vote across N independent runs

```ts
import { SelfConsistencyRunner, AnthropicModel, AnthropicModels } from "@wasmagent/core";

const runner = new SelfConsistencyRunner({
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
  tools: [],
  n: 5,
  concurrency: 3,
  earlyStop: true,
});

const answer = await runner.run("What is the capital of France?");
```

### Reflect-Refine — critique loop until quality signal passes

```ts
import { ReflectRefineRunner, AnthropicModel, AnthropicModels } from "@wasmagent/core";

const runner = new ReflectRefineRunner({
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
  tools: [],
  maxCycles: 3,
  qualitySignal: (answer) => answer.length > 100,
});

const answer = await runner.run("Write a detailed analysis of...");
```

### Parallel Fork-Join — diverse reasoning paths, synthesised answer

```ts
import { ParallelForkJoinRunner, AnthropicModel, AnthropicModels } from "@wasmagent/core";

const runner = new ParallelForkJoinRunner({
  branches: 3,
  concurrency: 3,
  aggregation: "summary",
  branchPrompt: (i, msgs) => [
    ...msgs,
    { role: "user", content: `Analyse from perspective ${i + 1} of 3.` },
  ],
});

const result = await runner.run(
  new AnthropicModel(AnthropicModels.SONNET_LATEST),
  [{ role: "user", content: "What are the trade-offs of microservices?" }]
);
console.log(result.answer);   // synthesised
console.log(result.branches); // individual paths
```

### Long-history compaction

```ts
import { CodeAgent, AnthropicModel, AnthropicModels, MessageAssembler } from "@wasmagent/core";

const model = new AnthropicModel(AnthropicModels.SONNET_LATEST);
const assembler = new MessageAssembler({ chunkSizeSteps: 8 });
const agent = new CodeAgent({
  tools: [],
  model,
  maxSteps: 50,
  assembler,
});

// Summarise old steps, keep context window in check
await agent.assembler.compact(model, 5);
```
