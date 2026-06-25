// Re-export policy primitives from mcp-firewall
export type { PolicyRule } from "@wasmagent/mcp-firewall";
export {
  ASK_HIGH_RISK_RULE,
  DEFAULT_RULES,
  DENY_BLOCKED_RULE,
  evaluatePolicy,
} from "@wasmagent/mcp-firewall";
export type { PolicyBundleMetadata } from "./bundle.js";
export { PolicyBundle } from "./bundle.js";
