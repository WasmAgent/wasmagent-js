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
 *
 * Note: `screen` from @testing-library is intentionally NOT used here because it
 * evaluates at CJS module-load time (before setup-dom.ts sets globalThis.document).
 * Each test instead destructures queries from render()'s return value.
 *
 * Note: React's synthetic onChange is triggered via direct props.onChange() + act()
 * because bun's CJS module cache causes react-dom to initialize without canUseDOM,
 * preventing fireEvent.change from propagating through React's event delegation.
 * This workaround is only needed when running cross-package from the repo root;
 * tests pass with standard fireEvent when run from `packages/devtools/`.
 */

import { describe, expect, it, mock } from "bun:test";
import "../setup-dom.ts";
import { act, fireEvent, render, within } from "@testing-library/react";
import type { AgentEvent } from "@wasmagent/core";
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

/**
 * Trigger a React-controlled input/textarea's onChange handler directly.
 *
 * fireEvent.change dispatches a DOM event that React's synthetic event delegation
 * should catch, but react-dom's canUseDOM / isInputEventSupported are captured at
 * CJS module-load time. When bun runs tests cross-package from the repo root, the
 * module may be cached before setup-dom.ts establishes globalThis.window, causing
 * the event delegation to silently skip the element. Calling props.onChange via
 * act() flushes the React scheduler so the state update is committed before the
 * subsequent fireEvent.click(submitButton).
 */
function setInputValue(element: HTMLElement, value: string): void {
  const propsKey = Object.keys(element).find((k) => k.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("Element has no __reactProps$ key (not a React node)");
  const props = (element as any)[propsKey];
  if (typeof props.onChange !== "function") throw new Error("Element has no onChange prop");
  Object.defineProperty(element, "value", { writable: true, configurable: true, value });
  act(() => {
    props.onChange({
      target: element,
      currentTarget: element,
      nativeEvent: new Event("change"),
      type: "change",
      preventDefault: () => {},
      stopPropagation: () => {},
      isPropagationStopped: () => false,
      persist: () => {},
    });
  });
}

describe("<DevTools /> render", () => {
  it("renders the testid root and reports step / event counts", () => {
    const { getByTestId } = render(<DevTools events={makeTrace()} traceId="abc" />);
    const root = getByTestId("agentkit-devtools");
    expect(root).toBeTruthy();
    // Header line includes the counts.
    expect(root.textContent).toContain("3 steps");
    expect(root.textContent).toContain("8 events");
  });

  it("initial cursor lands at end-of-trace and surfaces the final answer", () => {
    const { getByText, getAllByText } = render(<DevTools events={makeTrace()} traceId="abc" />);
    expect(getByText(/Cursor: step 3 \/ 3/)).toBeTruthy();
    expect(getByText("FINAL ANSWER")).toBeTruthy();
    // The answer text appears at least once — both inside the FINAL ANSWER
    // box and as the event-list summary line for the final_answer event.
    expect(getAllByText(/the result is 42/).length).toBeGreaterThanOrEqual(1);
  });

  it("clicking a step button moves the cursor and toggles aria-pressed", () => {
    const { getAllByRole, getByText, queryByText } = render(
      <DevTools events={makeTrace()} traceId="abc" />
    );
    const stepButtons = getAllByRole("button", { pressed: false });
    // Find the button labeled "1 · …events" — that's step 1.
    const step1 = stepButtons.find((b) => /^1\s+·/.test(b.textContent ?? ""));
    expect(step1).toBeTruthy();
    if (!step1) return; // narrow for TS — assertion above already failed test
    fireEvent.click(step1);
    expect(getByText(/Cursor: step 1 \/ 3/)).toBeTruthy();
    // The clicked button is now aria-pressed=true.
    expect(step1.getAttribute("aria-pressed")).toBe("true");
    // No final answer at step 1.
    expect(queryByText("FINAL ANSWER")).toBeNull();
  });

  it("clicking step 0 (prelude) shows only events before the first step_start", () => {
    const { getByRole, getByText } = render(<DevTools events={makeTrace()} traceId="abc" />);
    const preludeBtn = getByRole("button", { name: /^0\s+·\s+prelude$/ });
    fireEvent.click(preludeBtn);
    expect(getByText(/Cursor: step 0 \/ 3/)).toBeTruthy();
    // Only run_start should appear in the events list.
    const eventListLabel = getByText(/Events in prefix/i);
    const eventList = eventListLabel.parentElement;
    expect(eventList).not.toBeNull();
    if (!eventList) return;
    expect(within(eventList).getAllByText("run_start").length).toBeGreaterThan(0);
    expect(within(eventList).queryByText("step_start")).toBeNull();
  });

  it("Fork panel collects task/model overrides and fires onFork with the right prefix", () => {
    const onFork = mock<(fork: Fork) => void>();
    const { getByRole, getByText, getByLabelText } = render(
      <DevTools events={makeTrace()} traceId="abc" onFork={onFork} />
    );

    // Move cursor to step 2 first so the fork prefix is non-trivial.
    const step2 = getByRole("button", { name: /^2\s+·/ });
    fireEvent.click(step2);

    // Open the <details> panel.
    const summary = getByText(/Fork from step 2/);
    fireEvent.click(summary);

    // Fill the overrides. Use setInputValue() rather than fireEvent.change() because
    // React's event delegation may not be set up correctly when running cross-package
    // from the repo root (see module-level note above).
    setInputValue(getByLabelText(/Task override/i), "rerun with haiku");
    setInputValue(getByLabelText(/Model override/i), "claude-haiku-4-5");
    setInputValue(getByLabelText(/Note/i), "investigating regression");

    // Click the action button.
    fireEvent.click(getByRole("button", { name: /Fork & re-run/i }));

    expect(onFork).toHaveBeenCalledTimes(1);
    const fork = onFork.mock.calls[0]?.[0];
    expect(fork).toBeDefined();
    if (!fork) return;
    expect(fork.forkedAtStep).toBe(2);
    // Step 1's 3 events + Step 2's 2 events + the run_start preamble = 6.
    expect(fork.prefixEvents.length).toBe(6);
    expect(fork.meta.task).toBe("rerun with haiku");
    expect(fork.meta.modelId).toBe("claude-haiku-4-5");
    expect(fork.meta.note).toBe("investigating regression");
    expect(fork.meta.forkedFromTraceId).toBe("abc");
  });

  it("Fork panel passes through empty overrides as omitted fields", () => {
    const onFork = mock<(fork: Fork) => void>();
    const { getByRole, getByText } = render(
      <DevTools events={makeTrace()} traceId="abc" onFork={onFork} />
    );

    const summary = getByText(/Fork from step/);
    fireEvent.click(summary);
    fireEvent.click(getByRole("button", { name: /Fork & re-run/i }));

    const fork = onFork.mock.calls[0]?.[0];
    expect(fork).toBeDefined();
    if (!fork) return;
    // Default position is end-of-trace (step 3).
    expect(fork.forkedAtStep).toBe(3);
    expect(fork.meta.task).toBeUndefined();
    expect(fork.meta.modelId).toBeUndefined();
    expect(fork.meta.note).toBeUndefined();
  });

  it("renders without throwing when given a zero-step trace", () => {
    seq = 0;
    const events = [logged({ event: "run_start" })];
    const { getByTestId, queryByRole } = render(<DevTools events={events} />);
    expect(getByTestId("agentkit-devtools")).toBeTruthy();
    // 0 steps → no step buttons except "0 · prelude".
    expect(queryByRole("button", { name: /^1\s+·/ })).toBeNull();
  });

  it("renders the empty-trace edge case", () => {
    const { getByTestId } = render(<DevTools events={[]} />);
    const root = getByTestId("agentkit-devtools");
    expect(root.textContent).toContain("0 steps");
    expect(root.textContent).toContain("0 events");
  });
});
