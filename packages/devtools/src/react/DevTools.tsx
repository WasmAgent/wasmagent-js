/**
 * A2 — DevTools React component.
 *
 * Renders an event timeline, a step inspector, and a "fork from step N"
 * affordance. State and rendering only — the actual fork (running a fresh
 * agent on the prefix) is the host application's job; this component
 * surfaces the user's intent via `onFork`.
 *
 * The component is intentionally style-light — the host page can wrap it
 * or pass `className` props at the section boundaries. We don't ship CSS
 * to keep the bundle tiny.
 */

import { useMemo, useState } from "react";
import {
  EventLogReplay,
  type Fork,
  type ForkOptions,
  type LoggedEvent,
} from "../EventLogReplay.js";

export interface DevToolsProps {
  /** The full event log for one trace, as produced by EventLog.replay(). */
  events: LoggedEvent[];
  /** Optional trace id; surfaced in fork metadata. */
  traceId?: string;
  /**
   * Called when the user clicks "Fork from this step". The host application
   * should kick off a fresh agent run with the supplied prefix events and
   * the user-edited override (task / modelId / note).
   *
   * Returning a Promise is fine; the component does NOT await it (no spinner
   * UI in this baseline). Add your own status display in the host page.
   */
  onFork?: (fork: Fork) => void | Promise<void>;
}

export function DevTools({ events, traceId, onFork }: DevToolsProps) {
  const replay = useMemo(
    () => new EventLogReplay(events, traceId !== undefined ? { traceId } : {}),
    [events, traceId]
  );
  const [step, setStep] = useState(replay.stepCount);
  const [taskOverride, setTaskOverride] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [note, setNote] = useState("");

  const cursor = useMemo(() => replay.select(step), [replay, step]);

  const triggerFork = () => {
    const opts: ForkOptions = {};
    if (taskOverride.trim()) opts.task = taskOverride.trim();
    if (modelOverride.trim()) opts.modelId = modelOverride.trim();
    if (note.trim()) opts.note = note.trim();
    const fork = replay.forkAt(step, opts);
    void onFork?.(fork);
  };

  return (
    <div
      data-testid="agentkit-devtools"
      style={{ fontFamily: "ui-sans-serif, system-ui", fontSize: 13 }}
    >
      <header style={{ marginBottom: 8 }}>
        <strong>Agent DevTools</strong>
        <span style={{ color: "#888", marginLeft: 8 }}>
          {replay.stepCount} step{replay.stepCount === 1 ? "" : "s"} · {replay.eventCount} event
          {replay.eventCount === 1 ? "" : "s"}
        </span>
      </header>

      <div style={{ display: "flex", gap: 12 }}>
        {/* Timeline column */}
        <div style={{ minWidth: 220, borderRight: "1px solid #eee", paddingRight: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Steps</div>
          <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
            <li>
              <button
                type="button"
                onClick={() => setStep(0)}
                aria-pressed={step === 0}
                style={selectedStyle(step === 0)}
              >
                0 · prelude
              </button>
            </li>
            {replay.steps.map((s) => (
              <li key={s.startEventId}>
                <button
                  type="button"
                  onClick={() => setStep(s.step)}
                  aria-pressed={step === s.step}
                  style={selectedStyle(step === s.step)}
                >
                  {s.step} · {s.events.length} event{s.events.length === 1 ? "" : "s"}
                </button>
              </li>
            ))}
          </ol>
        </div>

        {/* Cursor + fork column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Cursor: step {cursor.currentStep} / {cursor.totalSteps}
          </div>
          {cursor.finalAnswer ? (
            <div
              style={{
                background: "#f6fff6",
                border: "1px solid #cfe9cf",
                padding: 6,
                marginBottom: 8,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 11, color: "#3a7" }}>FINAL ANSWER</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{cursor.finalAnswer}</div>
            </div>
          ) : null}

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Events in prefix</div>
            <ul
              style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 200, overflow: "auto" }}
            >
              {cursor.prefixEvents.map((le) => (
                <li
                  key={le.eventId}
                  style={{ borderBottom: "1px solid #f3f3f3", padding: "2px 0" }}
                >
                  <code style={{ color: "#888", fontSize: 11 }}>{le.eventId}</code>{" "}
                  <strong>{le.event.event}</strong>{" "}
                  <span style={{ color: "#666" }}>{summarise(le.event)}</span>
                </li>
              ))}
            </ul>
          </div>

          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Fork from step {step}</summary>
            <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
              <label>
                <div style={{ fontSize: 11, color: "#666" }}>Task override (optional)</div>
                <textarea
                  rows={2}
                  value={taskOverride}
                  onChange={(e) => setTaskOverride(e.target.value)}
                  style={{ width: "100%", fontSize: 12 }}
                />
              </label>
              <label>
                <div style={{ fontSize: 11, color: "#666" }}>Model override (optional)</div>
                <input
                  value={modelOverride}
                  onChange={(e) => setModelOverride(e.target.value)}
                  placeholder="e.g. claude-haiku-4-5"
                  style={{ width: "100%", fontSize: 12 }}
                />
              </label>
              <label>
                <div style={{ fontSize: 11, color: "#666" }}>Note (optional)</div>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  style={{ width: "100%", fontSize: 12 }}
                />
              </label>
              <button type="button" onClick={triggerFork}>
                Fork & re-run
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function selectedStyle(selected: boolean): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "3px 6px",
    border: "1px solid transparent",
    background: selected ? "#eef" : "transparent",
    fontWeight: selected ? 600 : 400,
    cursor: "pointer",
    fontSize: 12,
  };
}

function summarise(ev: LoggedEvent["event"]): string {
  const data = (ev as { data?: Record<string, unknown> }).data;
  if (!data) return "";
  if ("answer" in data) {
    const a = data.answer;
    return typeof a === "string" ? a.slice(0, 80) : "";
  }
  if ("toolName" in data) return String(data.toolName);
  if ("step" in data) return `step ${String(data.step)}`;
  return "";
}
