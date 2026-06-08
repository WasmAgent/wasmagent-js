/**
 * Guardrails framework — Input / Output / Tool three-layer safety gates.
 *
 * Mirrors OpenAI Agents SDK guardrails pattern: guardrails run in parallel with
 * the main execution path, and a tripwire triggers fail-fast interruption.
 *
 * @module guardrails
 */

import type { ModelMessage } from "../models/types.js";

// ── Core types ─────────────────────────────────────────────────────────────────

/** Result from a single guardrail check. */
export interface GuardrailResult {
  /** Whether the tripwire was triggered (fail-fast). */
  tripwireTriggered: boolean;
  /** Optional metadata (reason, details, etc.). */
  metadata?: Record<string, unknown>;
}

export interface InputGuardrail {
  readonly name: string;
  /** Called with the raw task string and assembled messages before the first model call. */
  check(task: string, messages: ModelMessage[]): Promise<GuardrailResult> | GuardrailResult;
}

export interface OutputGuardrail {
  readonly name: string;
  /** Called with the raw answer text/object before emitting final_answer. */
  check(answer: unknown): Promise<GuardrailResult> | GuardrailResult;
}

export interface ToolGuardrail {
  readonly name: string;
  /** Called before each tool invocation. toolName + input. */
  check(toolName: string, input: unknown): Promise<GuardrailResult> | GuardrailResult;
}

// ── Built-in guardrails ────────────────────────────────────────────────────────

/** Blocks inputs that exceed a maximum character length. */
export function maxInputLength(chars: number): InputGuardrail {
  return {
    name: `maxInputLength(${chars})`,
    check(task) {
      return { tripwireTriggered: task.length > chars, metadata: { length: task.length, max: chars } };
    },
  };
}

/** Blocks outputs containing any of the given forbidden substrings (case-insensitive). */
export function forbiddenPhrases(phrases: string[]): OutputGuardrail {
  return {
    name: "forbiddenPhrases",
    check(answer) {
      const text = typeof answer === "string" ? answer : JSON.stringify(answer ?? "");
      const lower = text.toLowerCase();
      for (const phrase of phrases) {
        if (lower.includes(phrase.toLowerCase())) {
          return { tripwireTriggered: true, metadata: { phrase } };
        }
      }
      return { tripwireTriggered: false };
    },
  };
}

/** Blocks specific tool names from executing. */
export function denyTools(toolNames: string[]): ToolGuardrail {
  const denied = new Set(toolNames);
  return {
    name: `denyTools([${toolNames.join(",")}])`,
    check(toolName) {
      return { tripwireTriggered: denied.has(toolName), metadata: { toolName } };
    },
  };
}

// ── Runner helpers ─────────────────────────────────────────────────────────────

/** Run input guardrails in parallel and return the first tripwire result, or null. */
export async function runInputGuardrails(
  guardrails: InputGuardrail[],
  task: string,
  messages: ModelMessage[]
): Promise<{ guardrailName: string; result: GuardrailResult } | null> {
  if (guardrails.length === 0) return null;
  const results = await Promise.all(
    guardrails.map(async (g) => ({ name: g.name, result: await g.check(task, messages) }))
  );
  for (const { name, result } of results) {
    if (result.tripwireTriggered) return { guardrailName: name, result };
  }
  return null;
}

/** Run output guardrails in parallel and return the first tripwire result, or null. */
export async function runOutputGuardrails(
  guardrails: OutputGuardrail[],
  answer: unknown
): Promise<{ guardrailName: string; result: GuardrailResult } | null> {
  if (guardrails.length === 0) return null;
  const results = await Promise.all(
    guardrails.map(async (g) => ({ name: g.name, result: await g.check(answer) }))
  );
  for (const { name, result } of results) {
    if (result.tripwireTriggered) return { guardrailName: name, result };
  }
  return null;
}

/** Run tool guardrails in parallel and return the first tripwire result, or null. */
export async function runToolGuardrails(
  guardrails: ToolGuardrail[],
  toolName: string,
  input: unknown
): Promise<{ guardrailName: string; result: GuardrailResult } | null> {
  if (guardrails.length === 0) return null;
  const results = await Promise.all(
    guardrails.map(async (g) => ({ name: g.name, result: await g.check(toolName, input) }))
  );
  for (const { name, result } of results) {
    if (result.tripwireTriggered) return { guardrailName: name, result };
  }
  return null;
}
