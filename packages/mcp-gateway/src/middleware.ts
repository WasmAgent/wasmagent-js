/**
 * GatewayMiddleware — composable request/response middleware for MCPGateway.
 */
import type { GatewayDecision, GatewayRequest } from "@wasmagent/mcp-firewall";

export interface MiddlewareContext {
  request: GatewayRequest;
  decision?: GatewayDecision;
  metadata: Record<string, unknown>;
}

export type NextFn = (ctx: MiddlewareContext) => Promise<MiddlewareContext>;

export interface GatewayMiddleware {
  name: string;
  handle(ctx: MiddlewareContext, next: NextFn): Promise<MiddlewareContext>;
}

export function composeMiddleware(middlewares: GatewayMiddleware[]): NextFn {
  return async function dispatch(ctx: MiddlewareContext): Promise<MiddlewareContext> {
    let i = 0;
    const run = async (c: MiddlewareContext): Promise<MiddlewareContext> => {
      const index = i;
      if (index >= middlewares.length) return c;
      i++;
      const mw = middlewares[index];
      if (!mw) return c;
      // Per-dispatch next(): a middleware calling next() twice (retry, forked
      // logging) previously re-ran the whole downstream chain silently —
      // double-emitting evidence and audit entries. Make it a loud error.
      let called = false;
      const onceNext: NextFn = async (nextCtx: MiddlewareContext) => {
        if (called) {
          throw new Error(
            `Middleware "${mw.name}" called next() twice — the downstream chain would execute more than once.`
          );
        }
        called = true;
        return run(nextCtx);
      };
      return mw.handle(c, onceNext);
    };
    return run(ctx);
  };
}

export const noopMiddleware: GatewayMiddleware = {
  name: "noop",
  async handle(ctx, next) {
    return next(ctx);
  },
};
