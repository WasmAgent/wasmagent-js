/**
 * A2 — DevTools React render tests.
 *
 * Real jsdom rendering via @testing-library/react. Covers:
 *   - initial cursor lands at end-of-trace; final answer surfaces
 *   - clicking a step button changes the cursor (aria-pressed reflects it)
 *   - prefix events list shrinks/grows in step with the cursor
 *   - the Fork details panel opens; submitting it fires onFork with the
 *     correct prefix size + meta (task / model overrides + fork point)
 *   - empty / zero-step traces render without throwing
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agentkit-js/core";
import type { Fork, LoggedEvent } from "../EventLogReplay.js";
import { DevTools } from "./DevTools.js";

let seq = 0;
function logged(event: { event: string; data?: Record<string, unknown> }): LoggedEvent {
  seq += 1;
  return {
    eventId: String(seq).padStart(6, "0"),
    event: {
      traceId: "t",
      parentTraceId: null,
      channel: "text",
      timestampMs: 0,
      data: {},
      ...event,
    } as unknown as AgentEvent,
  };
}

function makeTrace(): LoggedEvent[] {
  seq = 0;
  return [
    logged({ event: "run_start" }),
    logged({ event: "step_start", data: { step: 1 } }),
    logged({ event: "tool_call_start", data: { toolName: "read_file" } }),
    logged({ event: "tool_call_end", data: { toolName: "read_file" } }),
    logged({ event: "step_start", data: { step: 2 } }),
    logged({ event: "model_done", data: { inputTokens: 10 } }),
    logged({ event: "step_start", data: { step: 3 } }),
    logged({ event: "final_answer", data: { answer: "the result is 42" } }),
  ];
}

describe("<DevTools /> render", () => {
  it("renders the testid root and reports step / event counts", () => {
    render(<DevTools events={makeTrace()} traceId="abc" />);
    const root = screen.getByTestId("agentkit-devtools");
    expect(root).toBeTruthy();
    // Header line includes the counts.
    expect(root.textContent).toContain("3 steps");
    expect(root.textContent).toContain("8 events");
  });

  it("initial cursor lands at end-of-trace and surfaces the final answer", () => {
    render(<DevTools events={makeTrace()} traceId="abc" />);
    expect(screen.getByText(/Cursor: step 3 \/ 3/)).toBeTruthy();
    expect(screen.getByText("FINAL ANSWER")).toBeTruthy();
    // The answer text appears at least once — both inside the FINAL ANSWER
    // box and as the event-list summary line for the final_answer event.
    expect(screen.getAllByText(/the result is 42/).length).toBeGreaterThanOrEqual(1);
  });

  it("clicking a step button moves the cursor and toggles aria-pressed", () => {
    render(<DevTools events={makeTrace()} traceId="abc" />);
    const stepButtons = screen.getAllByRole("button", { pressed: false });
    // Find the button labeled "1 · …events" — that's step 1.
    const step1 = stepButtons.find((b) => /^1\s+·/.test(b.textContent ?? ""));
    expect(step1).toBeTruthy();
    fireEvent.click(step1!);
    expect(screen.getByText(/Cursor: step 1 \/ 3/)).toBeTruthy();
    // The clicked button is now aria-pressed=true.
    expect(step1!.getAttribute("aria-pressed")).toBe("true");
    // No final answer at step 1.
    expect(screen.queryByText("FINAL ANSWER")).toBeNull();
  });

  it("clicking step 0 (prelude) shows only events before the first step_start", () => {
    render(<DevTools events={makeTrace()} traceId="abc" />);
    const preludeBtn = screen.getByRole("button", { name: /^0\s+·\s+prelude$/ });
    fireEvent.click(preludeBtn);
    expect(screen.getByText(/Cursor: step 0 \/ 3/)).toBeTruthy();
    // Only run_start should appear in the events list.
    const eventList = screen.getByText(/Events in prefix/i).parentElement!;
    expect(within(eventList).getAllByText("run_start").length).toBeGreaterThan(0);
    expect(within(eventList).queryByText("step_start")).toBeNull();
  });

  it("Fork panel collects task/model overrides and fires onFork with the right prefix", () => {
    const onFork = vi.fn<(fork: Fork) => void>();
    render(<DevTools events={makeTrace()} traceId="abc" onFork={onFork} />);

    // Move cursor to step 2 first so the fork prefix is non-trivial.
    const step2 = screen.getByRole("button", { name: /^2\s+·/ });
    fireEvent.click(step2);

    // Open the <details> panel.
    const summary = screen.getByText(/Fork from step 2/);
    fireEvent.click(summary);

    // Fill the overrides.
    const taskBox = screen.getByLabelText(/Task override/i) as HTMLTextAreaElement;
    fireEvent.change(taskBox, { target: { value: "rerun with haiku" } });
    const modelBox = screen.getByLabelText(/Model override/i) as HTMLInputElement;
    fireEvent.change(modelBox, { target: { value: "claude-haiku-4-5" } });
    const noteBox = screen.getByLabelText(/Note/i) as HTMLInputElement;
    fireEvent.change(noteBox, { target: { value: "investigating regression" } });

    // Click the action button.
    fireEvent.click(screen.getByRole("button", { name: /Fork & re-run/i }));

    expect(onFork).toHaveBeenCalledTimes(1);
    const fork = onFork.mock.calls[0]![0];
    expect(fork.forkedAtStep).toBe(2);
    // Step 1's 3 events + Step 2's 2 events + the run_start preamble = 6.
    expect(fork.prefixEvents.length).toBe(6);
    expect(fork.meta.task).toBe("rerun with haiku");
    expect(fork.meta.modelId).toBe("claude-haiku-4-5");
    expect(fork.meta.note).toBe("investigating regression");
    expect(fork.meta.forkedFromTraceId).toBe("abc");
  });

  it("Fork panel passes through empty overrides as omitted fields", () => {
    const onFork = vi.fn<(fork: Fork) => void>();
    render(<DevTools events={makeTrace()} traceId="abc" onFork={onFork} />);

    const summary = screen.getByText(/Fork from step/);
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: /Fork & re-run/i }));

    const fork = onFork.mock.calls[0]![0];
    // Default position is end-of-trace (step 3).
    expect(fork.forkedAtStep).toBe(3);
    expect(fork.meta.task).toBeUndefined();
    expect(fork.meta.modelId).toBeUndefined();
    expect(fork.meta.note).toBeUndefined();
  });

  it("renders without throwing when given a zero-step trace", () => {
    seq = 0;
    const events = [logged({ event: "run_start" })];
    render(<DevTools events={events} />);
    expect(screen.getByTestId("agentkit-devtools")).toBeTruthy();
    // 0 steps → no step buttons except "0 · prelude".
    expect(screen.queryByRole("button", { name: /^1\s+·/ })).toBeNull();
  });

  it("renders the empty-trace edge case", () => {
    render(<DevTools events={[]} />);
    const root = screen.getByTestId("agentkit-devtools");
    expect(root.textContent).toContain("0 steps");
    expect(root.textContent).toContain("0 events");
  });
});
