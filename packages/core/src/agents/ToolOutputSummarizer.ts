/**
 * ToolOutputSummarizer — deterministic head+tail truncation for tool outputs.
 *
 * Training data and LLM inference context must see the same compressed version.
 * Call this on every tool_result.output before JSONL persistence and before
 * passing to the model — the two call sites must use identical options.
 *
 * Zero LLM calls; behaviour is fully deterministic and unit-testable.
 */

export interface SummarizeOptions {
  /** Byte threshold: outputs shorter than this are returned verbatim. Default 800. */
  maxBytes?: number;
  /** Lines to keep from the start of long output. Default 3. */
  keepFirstLines?: number;
  /** Lines to keep from the end of long output. Default 5. */
  keepLastLines?: number;
}

/**
 * Compress a raw tool output string for use in training data and LLM context.
 *
 * Returns the original string unchanged if it fits within maxBytes.
 * Otherwise retains the first keepFirstLines and last keepLastLines lines
 * separated by a `[...N lines omitted...]` marker.
 */
export function summarizeToolOutput(raw: string, opts: SummarizeOptions = {}): string {
  if (!raw) return raw;

  const maxBytes = opts.maxBytes ?? 800;
  const keepFirst = opts.keepFirstLines ?? 3;
  const keepLast = opts.keepLastLines ?? 5;

  if (raw.length < maxBytes) return raw;

  const lines = raw.split("\n");
  const total = lines.length;

  // If there are few enough lines that head+tail would overlap or cover all,
  // just return the original to avoid a misleading omission marker.
  if (keepFirst + keepLast >= total) return raw;

  const head = lines.slice(0, keepFirst);
  const tail = lines.slice(total - keepLast);
  const omitted = total - keepFirst - keepLast;

  return [...head, `[...${omitted} lines omitted...]`, ...tail].join("\n");
}
