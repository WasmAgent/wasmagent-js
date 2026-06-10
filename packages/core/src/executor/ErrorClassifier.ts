/**
 * ErrorClassifier — GPT-Engineer improve_loop pattern adapted for agentkit-js.
 *
 * Classifies execution errors into recovery strategies, enabling the agent to:
 * - Retry with a structured fix prompt (most common)
 * - Back off and retry after delay (transient errors)
 * - Fail fast (unrecoverable errors)
 *
 * Based on bolt.diy's #createEnhancedShellError and GPT-Engineer's bounded
 * diff-correction loop (MAX_EDIT_REFINEMENT_STEPS = 2-3).
 */

export const MAX_REFINEMENT_STEPS = 3;

export enum ErrorRecoveryStrategy {
  /** Retry immediately with structured fix prompt — most errors */
  RETRY_WITH_FIX = "retry",
  /** Exponential backoff then retry — transient/rate-limit errors */
  BACKOFF_AND_RETRY = "backoff",
  /** Abort and surface to user — permission/quota/impossible tasks */
  FAIL_FAST = "fail_fast",
}

export interface ErrorClassification {
  strategy: ErrorRecoveryStrategy;
  errorType: string;
  /** Structured fix hint to inject into the next model turn (GPT-Engineer pattern) */
  fixHint?: string;
  /** Suggested backoff ms for BACKOFF_AND_RETRY strategy */
  backoffMs?: number;
}

/**
 * Classify a kernel/tool execution error into a recovery strategy.
 *
 * Pattern priority: most specific match wins.
 * Returns RETRY_WITH_FIX as default with a generic hint.
 */
export function classifyExecutionError(
  error: Error | string,
  _context?: { toolName?: string; step?: number; attempt?: number }
): ErrorClassification {
  const msg = typeof error === "string" ? error : (error.message ?? String(error));

  // ── Unrecoverable — fail fast ─────────────────────────────────────────────
  if (/permission denied|EACCES|EPERM|access denied/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.FAIL_FAST,
      errorType: "permission_denied",
      fixHint: `Permission denied. The agent cannot access this resource.`,
    };
  }
  if (/quota exceeded|billing|payment required|insufficient funds/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.FAIL_FAST,
      errorType: "quota_exceeded",
      fixHint: `Resource quota exceeded. Cannot continue.`,
    };
  }
  if (/invalid api key|unauthorized|401/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.FAIL_FAST,
      errorType: "auth_failed",
      fixHint: `Authentication failed. Check API credentials.`,
    };
  }
  if (/out of memory|heap out of memory|JavaScript heap/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.FAIL_FAST,
      errorType: "out_of_memory",
      fixHint: `Memory limit exceeded. The computation is too large for the sandbox.`,
    };
  }

  // ── Transient — backoff and retry ─────────────────────────────────────────
  if (/rate limit|429|too many requests|overloaded/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.BACKOFF_AND_RETRY,
      errorType: "rate_limited",
      backoffMs: 5000,
      fixHint: `Rate limited. Retrying after delay.`,
    };
  }
  if (/network|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.BACKOFF_AND_RETRY,
      errorType: "network_error",
      backoffMs: 2000,
      fixHint: `Network error. Retrying.`,
    };
  }

  // ── Recoverable — retry with structured fix ───────────────────────────────
  if (/no such file|ENOENT|file not found|cannot find module/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.RETRY_WITH_FIX,
      errorType: "file_not_found",
      fixHint:
        `File or module not found: "${extractFilePath(msg)}". ` +
        `Check the path, verify the file exists, or create it first.`,
    };
  }
  if (/SyntaxError|ParseError|Unexpected token|Unexpected end/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.RETRY_WITH_FIX,
      errorType: "syntax_error",
      fixHint:
        `Syntax error in generated code. Review the error and rewrite the ` +
        `affected code block with correct syntax.`,
    };
  }
  if (/TypeError|ReferenceError/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.RETRY_WITH_FIX,
      errorType: "runtime_error",
      fixHint:
        `Runtime error: ${msg.slice(0, 150)}. ` +
        `Check variable names, types, and that all referenced values are defined.`,
    };
  }
  if (/import|require.*not found|cannot find.*module/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.RETRY_WITH_FIX,
      errorType: "missing_dependency",
      fixHint: `Missing dependency. Add it to package.json dependencies and npm install will run automatically.`,
    };
  }
  if (/timeout|timed out|execution exceeded/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.RETRY_WITH_FIX,
      errorType: "timeout",
      fixHint: `Execution timed out. Simplify the algorithm or reduce the input size.`,
    };
  }
  if (/assertion|AssertionError|expect.*received/i.test(msg)) {
    return {
      strategy: ErrorRecoveryStrategy.RETRY_WITH_FIX,
      errorType: "assertion_failed",
      fixHint:
        `Assertion failed: ${msg.slice(0, 150)}. ` +
        `Review the logic and fix the implementation to match the expected output.`,
    };
  }

  // ── Default — retry with generic hint ─────────────────────────────────────
  return {
    strategy: ErrorRecoveryStrategy.RETRY_WITH_FIX,
    errorType: "unknown",
    fixHint:
      `Execution failed: ${msg.slice(0, 200)}. ` +
      `Analyze the error and try a different approach.`,
  };
}

/**
 * Build a structured retry message (GPT-Engineer improve_loop pattern).
 * Injects both the error details and a specific fix hint into the conversation.
 */
export function buildFixRetryMessage(
  classification: ErrorClassification,
  originalCode: string,
  attempt: number
): string {
  const attemptLabel = attempt > 1 ? ` (attempt ${attempt}/${MAX_REFINEMENT_STEPS})` : "";
  const codeSnippet = originalCode.length > 400 ? `${originalCode.slice(0, 400)}…` : originalCode;

  return [
    `Execution failed${attemptLabel}.`,
    ``,
    `**Error type**: ${classification.errorType}`,
    `**Fix hint**: ${classification.fixHint ?? "Try a different approach."}`,
    ``,
    `**Previous code that failed**:`,
    "```",
    codeSnippet,
    "```",
    ``,
    `Rewrite the code to fix the issue above.`,
  ].join("\n");
}

/** Extract a file path from an error message for better hints. */
function extractFilePath(msg: string): string {
  const pathMatch =
    /'([^']+\.(js|ts|py|json|txt|md|css|html))'/.exec(msg) ??
    /"([^"]+\.(js|ts|py|json|txt|md|css|html))"/.exec(msg);
  return pathMatch?.[1] ?? "unknown";
}
