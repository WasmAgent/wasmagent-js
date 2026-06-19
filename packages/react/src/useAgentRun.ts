/**
 * useAgentRun — React hook for streaming agentkit-js AgentEvent SSE output (B2).
 *
 * Consumes a Server-Sent Events stream from the agentkit Cloudflare Worker `/run`
 * endpoint (or any compatible SSE endpoint that sends `data: <AgentEvent json>\n\n`).
 *
 * Usage:
 *   const { messages, status, isRunning, finalAnswer, run } = useAgentRun("/api/run");
 *
 *   // Trigger a run:
 *   run({ task: "What is 2 + 2?" });
 *
 * The hook accumulates `text_delta` events into messages and tracks tool execution
 * status. It exposes `isRunning` so the UI can show a spinner during execution.
 */

import type { AgentEvent } from "@wasmagent/core";
import { useCallback, useEffect, useRef, useState } from "react";

export type MessageRole = "assistant" | "tool" | "error";

export interface AgentMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Tool name, if role is "tool". */
  toolName?: string;
  /** Call ID from the tool_call event, used to match tool_result to the right message. */
  callId?: string;
  /** True when the tool returned an error. */
  isError?: boolean;
}

export type AgentRunStatus = "idle" | "running" | "complete" | "error";

export interface UseAgentRunOptions {
  /** POST /run endpoint URL. Default: "/run". */
  endpoint?: string;
  /** Extra headers to send with the request. */
  headers?: Record<string, string>;
  /** Called whenever a new AgentEvent is received. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * A2 — Auto-retry policy for transient SSE disconnects (network blip,
   * Workers cold-start kick). When enabled the hook reconnects with the
   * `Last-Event-ID` header set to the highest id received so far, so the
   * server replays only the missing tail.
   *
   * @default { maxAttempts: 0 }  // off — caller must opt in
   */
  resume?: {
    /** Max retry attempts after a stream ends without final_answer. 0 disables. */
    maxAttempts?: number;
    /** Backoff in ms between attempts. Default: 1000. */
    delayMs?: number;
  };
}

export interface UseAgentRunReturn {
  messages: AgentMessage[];
  status: AgentRunStatus;
  isRunning: boolean;
  finalAnswer: string | null;
  /** Trigger a new agent run. Previous state is cleared. */
  run: (payload: { task: string; [key: string]: unknown }) => void;
  /** Abort the current run. */
  abort: () => void;
  /** Reset all state back to idle. */
  reset: () => void;
}

let _idCounter = 0;
function nextId(): string {
  return `msg-${++_idCounter}`;
}

export function useAgentRun(
  endpointOrOpts?: string | UseAgentRunOptions,
  opts?: UseAgentRunOptions
): UseAgentRunReturn {
  const resolvedOpts: UseAgentRunOptions =
    typeof endpointOrOpts === "string"
      ? { endpoint: endpointOrOpts, ...opts }
      : (endpointOrOpts ?? {});
  const endpoint = resolvedOpts.endpoint ?? "/run";

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AgentRunStatus>("idle");
  const [finalAnswer, setFinalAnswer] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Abort any in-flight run when the component unmounts to prevent setState
  // calls on an unmounted component and to close the network connection.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);
  // Buffer for ongoing text_delta accumulation — flushed on tool_call or final_answer.
  const textBufRef = useRef<string>("");
  const textMsgIdRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus("idle");
    setFinalAnswer(null);
    textBufRef.current = "";
    textMsgIdRef.current = null;
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setStatus("idle");
  }, []);

  const run = useCallback(
    (payload: { task: string; [key: string]: unknown }) => {
      // Cancel any previous run.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setMessages([]);
      setStatus("running");
      setFinalAnswer(null);
      textBufRef.current = "";
      textMsgIdRef.current = null;

      const flushText = (setState: typeof setMessages) => {
        const text = textBufRef.current.trim();
        if (!text) return;
        const id = textMsgIdRef.current ?? nextId();
        textMsgIdRef.current = id;
        setState((prev) => {
          const existing = prev.find((m) => m.id === id);
          if (existing) {
            return prev.map((m) => (m.id === id ? { ...m, content: text } : m));
          }
          return [...prev, { id, role: "assistant" as const, content: text }];
        });
        textBufRef.current = "";
        textMsgIdRef.current = null;
      };

      // ── A2: Last-Event-ID resume state ─────────────────────────────────────
      // Reset across run() invocations; mutated as the worker streams events.
      let lastEventId: string | null = null;
      let traceId: string | null = null;
      let receivedFinalAnswer = false;
      const resumeOpts = resolvedOpts.resume ?? {};
      const maxAttempts = resumeOpts.maxAttempts ?? 0;
      const delayMs = resumeOpts.delayMs ?? 1000;

      (async () => {
        // attemptStream returns:
        //   { kind: "complete" }   — saw final_answer or "[DONE]" line; success
        //   { kind: "error", msg } — server returned non-2xx or threw
        //   { kind: "interrupted" }— stream ended without final_answer (resume opportunity)
        type AttemptOutcome =
          | { kind: "complete" }
          | { kind: "error"; msg: string }
          | { kind: "interrupted" };
        const attemptStream = async (): Promise<AttemptOutcome> => {
          // Build headers, including Last-Event-ID on retries.
          const reqHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            ...resolvedOpts.headers,
          };
          if (lastEventId) reqHeaders["Last-Event-ID"] = lastEventId;

          // On retry the server uses `resumeTraceId` to skip starting a new
          // agent and replay-only the missing tail. Always set on retries so
          // a worker that crashed mid-run can be resumed by a different
          // worker instance — both share KV-persisted EventLog.
          const reqBody = traceId ? { ...payload, resumeTraceId: traceId } : payload;

          const resp = await fetch(endpoint, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify(reqBody),
            signal: ac.signal,
          });

          if (!resp.ok || !resp.body) {
            let errorMsg = `HTTP ${resp.status}`;
            try {
              const ct = resp.headers.get("content-type") ?? "";
              if (ct.includes("application/json")) {
                const body = (await resp.json()) as { error?: string; message?: string };
                if (body.error) errorMsg = `${errorMsg}: ${body.error}`;
                else if (body.message) errorMsg = `${errorMsg}: ${body.message}`;
              } else {
                const text = (await resp.text()).trim();
                if (text && text.length < 200) errorMsg = `${errorMsg}: ${text}`;
              }
            } catch {
              // Body already consumed or unreadable — use the bare status.
            }
            return { kind: "error", msg: errorMsg };
          }

          // Capture trace id from server so subsequent retries point at
          // the same persisted event log.
          const t = resp.headers.get("X-Agentkit-Trace-Id");
          if (t) traceId = t;

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          // Track the last `id:` line within the current SSE event block —
          // emitted only on flush (blank-line terminator).
          let pendingId: string | null = null;
          let sawDone = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("id: ")) {
                pendingId = line.slice(4).trim();
                continue;
              }
              if (line === "") {
                // End of SSE event — commit pending id as the new high-water mark.
                if (pendingId) {
                  lastEventId = pendingId;
                  pendingId = null;
                }
                continue;
              }
              if (!line.startsWith("data: ")) continue;
              const payloadLine = line.slice(6).trim();
              if (payloadLine === "[DONE]") {
                sawDone = true;
                break;
              }
              let ev: AgentEvent;
              try {
                ev = JSON.parse(payloadLine) as AgentEvent;
              } catch {
                continue;
              }
              resolvedOpts.onEvent?.(ev);

              if (ev.event === "thinking_delta" && ev.channel === "thinking") {
                const delta = (ev as { data: { delta: string } }).data.delta ?? "";
                textBufRef.current += delta;
                const text = textBufRef.current.trim();
                if (text) {
                  setMessages((prev) => {
                    if (!textMsgIdRef.current) textMsgIdRef.current = nextId();
                    const id = textMsgIdRef.current;
                    const existing = prev.find((m) => m.id === id);
                    if (existing)
                      return prev.map((m) => (m.id === id ? { ...m, content: text } : m));
                    return [...prev, { id, role: "assistant" as const, content: text }];
                  });
                }
              } else if (ev.event === "tool_call" && ev.channel === "tool") {
                flushText(setMessages);
                const d = (ev as { data: { toolName: string; callId: string } }).data;
                setMessages((prev) => [
                  ...prev,
                  {
                    id: nextId(),
                    role: "tool" as const,
                    content: `Calling ${d.toolName}…`,
                    toolName: d.toolName,
                    callId: d.callId,
                  },
                ]);
              } else if (ev.event === "tool_result" && ev.channel === "tool") {
                const d = (
                  ev as {
                    data: { toolName: string; callId: string; output?: unknown; error?: unknown };
                  }
                ).data;
                const isError = !!d.error;
                // Show tool output when available (e.g. "OK: written 371 chars to src/App.tsx")
                const outputStr = String(d.output ?? "").trim();
                const label = isError
                  ? `${d.toolName} failed`
                  : outputStr
                    ? `${d.toolName}: ${outputStr.slice(0, 120)}`
                    : `${d.toolName} done`;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.callId === d.callId
                      ? { ...m, content: label, isError }
                      : m
                  )
                );
              } else if (ev.event === "final_answer" && ev.channel === "text") {
                flushText(setMessages);
                receivedFinalAnswer = true;
                const raw = (ev as { data: { answer: unknown } }).data.answer;
                // Coerce to a renderable string. String(arr/object) gives
                // "[object Object]" or comma-joined "[object Object],..."
                // — useless. JSON-stringify gives readable structure.
                const answer =
                  raw == null
                    ? ""
                    : typeof raw === "string"
                      ? raw
                      : ((): string => {
                          try {
                            return JSON.stringify(raw, null, 2) ?? String(raw);
                          } catch {
                            return String(raw);
                          }
                        })();
                setFinalAnswer(answer);
                setMessages((prev) => [
                  ...prev,
                  { id: nextId(), role: "assistant" as const, content: answer },
                ]);
                setStatus("complete");
              } else if (ev.event === "error" && ev.channel === "text") {
                const errMsg = (ev as { data: { error: string } }).data.error ?? "Unknown error";
                setMessages((prev) => [
                  ...prev,
                  { id: nextId(), role: "error" as const, content: errMsg },
                ]);
                setStatus("error");
              }
            }
            if (sawDone) break;
          }
          if (sawDone || receivedFinalAnswer) return { kind: "complete" };
          // Stream ended without final_answer or [DONE] — caller may retry.
          return { kind: "interrupted" };
        };

        try {
          let attempts = 0;
          // First attempt + up to maxAttempts retries on interruption.
          while (true) {
            const outcome = await attemptStream();
            if (outcome.kind === "complete") break;
            if (outcome.kind === "error") {
              setStatus("error");
              setMessages((prev) => [
                ...prev,
                { id: nextId(), role: "error", content: outcome.msg },
              ]);
              return;
            }
            // outcome.kind === "interrupted"
            if (attempts >= maxAttempts) break;
            attempts++;
            // Wait before retry; abort signal short-circuits the wait.
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delayMs);
              ac.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  resolve();
                },
                { once: true }
              );
            });
            if (ac.signal.aborted) return;
          }
          if (status !== "complete" && status !== "error") {
            setStatus("idle");
          }
        } catch (e) {
          if ((e as Error)?.name === "AbortError") return;
          setStatus("error");
          setMessages((prev) => [...prev, { id: nextId(), role: "error", content: String(e) }]);
        }
        // suppress unused-variable warning for traceId — read on retries via
        // closure inside attemptStream() (resumeTraceId in body) and surfaced
        // via the X-Agentkit-Trace-Id response header for debuggers.
        void traceId;
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [endpoint, status, resolvedOpts.onEvent, resolvedOpts.headers, resolvedOpts.resume]
  );

  return {
    messages,
    status,
    isRunning: status === "running",
    finalAnswer,
    run,
    abort,
    reset,
  };
}
