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
      if (i >= middlewares.length) return c;
      const mw = middlewares[i++];
      if (!mw) return c;
      return mw.handle(c, run);
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
