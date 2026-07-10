---
"@wasmagent/core": minor
"@wasmagent/evals-runner": minor
---

feat: rollout tree topology, SFT annotator, symmetric memory, and linearisation ablation benchmark

- RolloutTreeExporter: serialise fork-point topology for step-level DPO credit assignment (#69)
- RolloutSFTAnnotator: score-based high_value turn detection without named pattern enumeration (#70)
- Linearisation ablation benchmark suite in evals-runner with 4 serialization variants (#71)
- RolloutMemoryStore: symmetric trajectory memory with includeAllScores option (#72)
