/**
 * StreamingActionParser — bolt.diy StreamingMessageParser pattern.
 *
 * Parses LLM token streams in real-time to extract discrete actions
 * (file writes, shell commands, code blocks) without waiting for the full response.
 *
 * This enables:
 * - Progressive artifact rendering in the frontend (artifact_delta events)
 * - File writes to start before the model finishes generating
 * - Better observability of what the model is doing as it streams
 *
 * Supports:
 * - bolt.new-style: <boltAction type="file" filePath="...">content</boltAction>
 * - Fenced code blocks: ```language\ncontent\n```
 * - Shell actions: <boltAction type="shell">command</boltAction>
 */

import { randomUUID } from "../util/runtime.js";

export type ParsedActionType = "file" | "shell" | "code";

export interface ParsedAction {
  id: string;
  type: ParsedActionType;
  /** File path for "file" actions */
  filePath?: string | undefined;
  /** Code language for "code" actions (js, ts, python, etc.) */
  language?: string | undefined;
  /** Accumulated content so far */
  content: string;
  /** True when the closing tag/fence has been parsed */
  isComplete: boolean;
}

interface ParserState {
  /** Current in-flight action being accumulated */
  currentAction: ParsedAction | null;
  /** Completed actions ready for execution */
  completed: ParsedAction[];
  /** Unparsed tail of the buffer (incomplete tag/fence) */
  remainder: string;
}

/**
 * Stateful streaming parser.
 *
 * Call `feed(delta)` for each token chunk from the model.
 * Returns an array of newly-completed actions.
 * Use `getInProgress()` to poll the partially-complete action for live preview.
 */
export class StreamingActionParser {
  private state: ParserState = {
    currentAction: null,
    completed: [],
    remainder: "",
  };

  /**
   * Feed a new token delta into the parser.
   * Returns any actions that just completed in this chunk.
   */
  feed(delta: string): ParsedAction[] {
    this.state.remainder += delta;
    const justCompleted: ParsedAction[] = [];

    // Keep draining the buffer as long as we find complete patterns
    let progress = true;
    while (progress) {
      progress = false;

      if (this.state.currentAction === null) {
        // Scan for an action opener
        const opened = this.tryOpenAction();
        if (opened) {
          this.state.currentAction = opened;
          progress = true;
        }
      } else {
        // Try to close the current action
        const closed = this.tryCloseAction();
        if (closed) {
          justCompleted.push(closed);
          this.state.completed.push(closed);
          this.state.currentAction = null;
          progress = true;
        } else {
          // Accumulate content into current action
          this.accumulateContent();
        }
      }
    }

    return justCompleted;
  }

  /** Returns the partially-built action being streamed (for live preview). */
  getInProgress(): ParsedAction | null {
    return this.state.currentAction;
  }

  /** Returns all fully completed actions. */
  getCompleted(): ParsedAction[] {
    return [...this.state.completed];
  }

  reset(): void {
    this.state = { currentAction: null, completed: [], remainder: "" };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private tryOpenAction(): ParsedAction | null {
    const buf = this.state.remainder;

    // bolt.new: <boltAction type="file" filePath="...">
    const boltFileMatch = /<boltAction\s+type="file"\s+filePath="([^"]*)">/i.exec(buf);
    if (boltFileMatch?.index !== undefined) {
      this.state.remainder = buf.slice(boltFileMatch.index + boltFileMatch[0].length);
      return {
        id: randomUUID(),
        type: "file",
        filePath: boltFileMatch[1],
        content: "",
        isComplete: false,
      };
    }

    // bolt.new: <boltAction type="shell">
    const boltShellMatch = /<boltAction\s+type="shell">/i.exec(buf);
    if (boltShellMatch?.index !== undefined) {
      this.state.remainder = buf.slice(boltShellMatch.index + boltShellMatch[0].length);
      return {
        id: randomUUID(),
        type: "shell",
        content: "",
        isComplete: false,
      };
    }

    // Fenced code block: ```language\n
    const fenceMatch = /```([\w]*)?\n/.exec(buf);
    if (fenceMatch?.index !== undefined) {
      this.state.remainder = buf.slice(fenceMatch.index + fenceMatch[0].length);
      return {
        id: randomUUID(),
        type: "code",
        language: fenceMatch[1] || undefined,
        content: "",
        isComplete: false,
      };
    }

    return null;
  }

  private tryCloseAction(): ParsedAction | null {
    const buf = this.state.remainder;
    const action = this.state.currentAction as ParsedAction;

    if (action.type === "file" || action.type === "shell") {
      const closeIdx = buf.indexOf("</boltAction>");
      if (closeIdx !== -1) {
        action.content += buf.slice(0, closeIdx);
        action.content = action.content.trim();
        action.isComplete = true;
        this.state.remainder = buf.slice(closeIdx + "</boltAction>".length);
        return action;
      }
    }

    if (action.type === "code") {
      // Closing fence must appear at start of a line
      const closeFenceMatch = /(?:^|\n)```/.exec(buf);
      if (closeFenceMatch?.index !== undefined) {
        // Include content up to (but not including) the closing fence
        const contentEnd = closeFenceMatch[0].startsWith("\n")
          ? closeFenceMatch.index + 1
          : closeFenceMatch.index;
        action.content += buf.slice(0, contentEnd);
        action.content = action.content.trim();
        action.isComplete = true;
        this.state.remainder = buf.slice(closeFenceMatch.index + closeFenceMatch[0].length);
        return action;
      }
    }

    return null;
  }

  private accumulateContent(): void {
    const buf = this.state.remainder;
    if (!this.state.currentAction || buf.length === 0) return;

    // Heuristic: keep a tail that might be the start of a closing tag
    // so we don't accidentally include it as content.
    const tailReserve = 20;
    if (buf.length <= tailReserve) return; // Don't accumulate yet — wait for more

    const safe = buf.slice(0, buf.length - tailReserve);
    this.state.currentAction.content += safe;
    this.state.remainder = buf.slice(safe.length);
  }
}

/**
 * Utility: extract all boltActions from a complete response string.
 * For post-hoc parsing when streaming is not available.
 */
export function extractActionsFromResponse(response: string): ParsedAction[] {
  const parser = new StreamingActionParser();
  parser.feed(response);
  // Flush remainder to handle any unclosed actions
  parser.feed("\n```\n</boltAction>\n");
  return parser.getCompleted();
}
