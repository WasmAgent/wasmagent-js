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

import type { AgentEvent } from "@agentkit-js/core";
import { useCallback, useRef, useState } from "react";

export type MessageRole = "assistant" | "tool" | "error";

export interface AgentMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Tool name, if role is "tool". */
  toolName?: string;
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

      (async () => {
        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...resolvedOpts.headers },
            body: JSON.stringify(payload),
            signal: ac.signal,
          });

          if (!resp.ok || !resp.body) {
            // Try to extract the worker's structured error message —
            // a bare "HTTP 400" tells the user nothing. The worker
            // typically returns {"error": "<reason>"} JSON. Fall back
            // to a status-only message only when the body isn't JSON.
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
            setStatus("error");
            setMessages((prev) => [...prev, { id: nextId(), role: "error", content: errorMsg }]);
            return;
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") break;
              let ev: AgentEvent;
              try {
                ev = JSON.parse(payload) as AgentEvent;
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
                    m.toolName === d.toolName && m.content.startsWith("Calling")
                      ? { ...m, content: label, isError }
                      : m
                  )
                );
              } else if (ev.event === "final_answer" && ev.channel === "text") {
                flushText(setMessages);
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
          }
          if (status !== "complete" && status !== "error") {
            setStatus("idle");
          }
        } catch (e) {
          if ((e as Error)?.name === "AbortError") return;
          setStatus("error");
          setMessages((prev) => [...prev, { id: nextId(), role: "error", content: String(e) }]);
        }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [endpoint, status, resolvedOpts.onEvent, resolvedOpts.headers]
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
