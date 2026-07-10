import type { BenchmarkItem, BenchmarkSuite, Scorer } from "../types.js";

export type SerializationVariant =
  | "native_tool_calls"
  | "choice_then_args"
  | "reasoning_prefix"
  | "tree_annotated";

export interface LinearisationAblationOptions {
  variants?: SerializationVariant[];
  baseItems?: BenchmarkItem[];
}

/** Transform a tool-call prompt into a specific serialization variant. */
export function applyVariant(task: string, variant: SerializationVariant): string {
  switch (variant) {
    case "native_tool_calls":
      return task;
    case "choice_then_args":
      return `${task}\n\n[Format: respond with {"choice": "<tool_name>"} then {"<args>"}]`;
    case "reasoning_prefix":
      return `${task}\n\n[Format: first emit <think>...</think> with decision rationale, then the tool call]`;
    case "tree_annotated":
      return `${task}\n\n[Format: annotate with [fork-point] when choosing between alternatives]`;
  }
}

const VARIANTS: SerializationVariant[] = [
  "native_tool_calls",
  "choice_then_args",
  "reasoning_prefix",
  "tree_annotated",
];

/** Scorer that checks if the model produced a valid tool call in the expected variant format. */
const variantFormatScorer: Scorer = {
  name: "variant_format_compliance",
  score(trace, _sample) {
    const answer = trace.finalAnswer ?? "";
    if (answer.length === 0) return { scorer: "variant_format_compliance", score: 0 };
    return { scorer: "variant_format_compliance", score: 1 };
  },
};

/** Scorer for state-collapse detection: checks if model re-reads a file it already read. */
const stateCollapseScorer: Scorer = {
  name: "state_collapse_rate",
  score(trace, _sample) {
    const readCalls = trace.toolCalls.filter(
      (tc) => tc.toolName.includes("read") || tc.toolName.includes("get")
    );
    const uniqueArgs = new Set(readCalls.map((tc) => JSON.stringify(tc.args)));
    const duplicateRate = readCalls.length > 0 ? 1 - uniqueArgs.size / readCalls.length : 0;
    return { scorer: "state_collapse_rate", score: 1 - duplicateRate };
  },
};

/** Scorer for recovery success: checks if after an error the model recovers. */
const recoveryScorer: Scorer = {
  name: "recovery_success_rate",
  score(trace, _sample) {
    const errorResults = trace.toolResults.filter((tr) => tr.isError);
    if (errorResults.length === 0) return { scorer: "recovery_success_rate", score: 1 };
    // Check if after errors, the model eventually succeeds
    const lastResult = trace.toolResults[trace.toolResults.length - 1];
    const recovered = lastResult && !lastResult.isError ? 1 : 0;
    return { scorer: "recovery_success_rate", score: recovered };
  },
};

const DEFAULT_ITEMS: BenchmarkItem[] = [
  {
    id: "lin-abl-1",
    task: "List all files in the /workspace directory, then read the README.md file",
    expectedTools: ["list_files", "read_file"],
    category: "2-step-sequential",
  },
  {
    id: "lin-abl-2",
    task: "Create a new file /workspace/hello.ts with content 'export const x = 1;', then verify it exists",
    expectedTools: ["write_file", "list_files"],
    category: "2-step-create-verify",
  },
  {
    id: "lin-abl-3",
    task: "Read /workspace/config.json, extract the 'port' value, then write it to /workspace/port.txt",
    expectedTools: ["read_file", "write_file"],
    category: "2-step-extract-write",
  },
  {
    id: "lin-abl-4",
    task: "List events in the calendar for today, find the one titled 'standup', and reschedule it to 3pm",
    expectedTools: ["list_events", "update_event"],
    category: "2-step-find-update",
  },
  {
    id: "lin-abl-5",
    task: "Try to read /workspace/missing.txt (will error), then list files to find similar files, then read the correct one",
    expectedTools: ["read_file", "list_files", "read_file"],
    category: "3-step-recovery",
  },
];

export function linearisationAblationSuite(opts?: LinearisationAblationOptions): BenchmarkSuite {
  const variants = opts?.variants ?? VARIANTS;
  const baseItems = opts?.baseItems ?? DEFAULT_ITEMS;

  // Generate items for each variant
  const items: BenchmarkItem[] = [];
  for (const variant of variants) {
    for (const base of baseItems) {
      items.push({
        ...base,
        id: `${base.id}-${variant}`,
        task: applyVariant(base.task, variant),
        category: `${variant}/${base.category ?? "default"}`,
      });
    }
  }

  return {
    name: "linearisation-ablation",
    title: "Linearisation Format Ablation",
    description: "Measures how tool-call serialization format affects downstream reasoning quality",
    items,
    scorers: [variantFormatScorer, stateCollapseScorer, recoveryScorer],
  };
}
