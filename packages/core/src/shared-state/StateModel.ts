/**
 * #134 — StateModel Contract
 *
 * Foundation interface for human-agent collaborative state management.
 * The LLM is a first-class participant: it reads projections, writes intent
 * via semantic actions, and respects affordances.
 */

/**
 * Core state model contract. Defines how state evolves via actions,
 * how it is projected for consumers, and which actions are currently valid.
 */
export interface StateModel<S, A extends { type: string }> {
  /** Produce the initial state for a fresh session. */
  initial(): S;

  /** Pure reducer: given current state and an action, return the next state. */
  reduce(state: S, action: A): S;

  /**
   * Optional projection: transform internal state into a read-friendly view.
   * Used by agents to understand context without full state access.
   */
  project?(state: S): unknown;

  /**
   * Optional affordances: return the set of action types currently valid.
   * Helps the agent know which actions it MAY dispatch.
   */
  affordances?(state: S): Array<A["type"]>;

  /**
   * Optional validator: parse and validate an unknown action payload.
   * Throws on invalid input. Used by agent tools to validate LLM output.
   */
  validate?(action: unknown): A;
}

/**
 * Identity helper for defining a state model with full type inference.
 */
export function defineStateModel<S, A extends { type: string }>(
  model: StateModel<S, A>
): StateModel<S, A> {
  return model;
}

/**
 * Replay a sequence of actions against a model to reconstruct state.
 * Useful for event-sourcing recovery and testing.
 */
export function replayActions<S, A extends { type: string }>(
  model: StateModel<S, A>,
  actions: A[],
  from?: S
): S {
  let state = from ?? model.initial();
  for (const action of actions) {
    state = model.reduce(state, action);
  }
  return state;
}

/**
 * Assert that a reducer is pure (does not mutate its input).
 * Freezes input state via JSON round-trip + Object.freeze, then calls reduce.
 * If reduce attempts mutation on the frozen object, it will throw.
 */
export function assertPure<S, A extends { type: string }>(
  model: StateModel<S, A>,
  state: S,
  action: A
): S {
  const frozen = JSON.parse(JSON.stringify(state)) as S;
  deepFreeze(frozen);
  const next = model.reduce(frozen, action);
  return next;
}

/** Recursively freeze an object and all nested objects/arrays. */
function deepFreeze(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
}
