/**
 * zodStateModel — Adapter that bridges a Zod action schema to the StateModel contract.
 *
 * Provides automatic `validate` via zod parse and `jsonSchema()` for tool input generation.
 */

import type { ZodSchema } from "zod";
import type { StateModel } from "./StateModel.js";

/**
 * Options for creating a zod-backed state model.
 */
export interface ZodStateModelOpts<S, A extends { type: string }> {
  initial: () => S;
  reduce: (state: S, action: A) => S;
  actionSchema: ZodSchema<A>;
  project?: (state: S) => unknown;
  affordances?: (state: S) => Array<A["type"]>;
}

/**
 * Extended state model with JSON Schema generation support.
 */
export interface ZodStateModel<S, A extends { type: string }> extends StateModel<S, A> {
  /** Generate a JSON Schema representation of the action schema. */
  jsonSchema(): object;
}

/**
 * Create a StateModel backed by a Zod schema for action validation.
 * Automatically wires `validate` to zod parse and provides `jsonSchema()`.
 */
export function zodStateModel<S, A extends { type: string }>(
  opts: ZodStateModelOpts<S, A>
): ZodStateModel<S, A> {
  const result: ZodStateModel<S, A> = {
    initial: opts.initial,
    reduce: opts.reduce,
    validate(action: unknown): A {
      return opts.actionSchema.parse(action);
    },
    jsonSchema(): object {
      // Use zod-to-json-schema if available at runtime; otherwise return
      // a minimal descriptor. This keeps the shared-state module itself
      // zero-dep — zod is already a peer dep of @wasmagent/core.
      try {
        // Dynamic import to avoid hard runtime dep; caller must have
        // zod-to-json-schema installed (it's a dep of @wasmagent/core).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { zodToJsonSchema } = require("zod-to-json-schema") as {
          zodToJsonSchema: (schema: ZodSchema) => object;
        };
        return zodToJsonSchema(opts.actionSchema);
      } catch {
        // Fallback: return a permissive schema when converter is unavailable
        return { type: "object", additionalProperties: true };
      }
    },
  };

  if (opts.project) {
    result.project = opts.project;
  }
  if (opts.affordances) {
    result.affordances = opts.affordances;
  }

  return result;
}
