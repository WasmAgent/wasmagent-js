/**
 * @wasmagent/mcp-gateway — alpha
 *
 * MCP Gateway — identity propagation, server card validation, policy enforcement,
 * AEP evidence emission for MCP tool invocations.
 *
 * Re-exports all of @wasmagent/mcp-firewall plus composable middleware and audit logging.
 */

// Re-export everything from @wasmagent/mcp-firewall
export type {
  ConsentAction,
  ConsentCacheKey,
  ConsentEvent,
  ConsentLedger,
  ConsentRecord,
  ContentType,
  GatewayDecision,
  GatewayRequest,
  InvocationDecision,
  MCPGatewayOptions,
  PolicyRule,
  RenderedTaintedObservation,
  RequestIdentity,
  RiskCategory,
  RiskRecommendation,
  RiskSeverity,
  ServerCard,
  TaintedObservation,
  ToolDescriptorSnapshot,
  ToolInvocationDecision,
  ToolRiskFinding,
  ToolRugPullEvent,
  TrustLevel,
  TrustTier,
  VettedField,
  VettingResult,
} from "@wasmagent/mcp-firewall";
export {
  ASK_HIGH_RISK_RULE,
  buildServerCard,
  buildVettingCacheKey,
  createRequestIdentity,
  DEFAULT_RULES,
  DENY_BLOCKED_RULE,
  detectRugPull,
  evaluatePolicy,
  hashContent,
  hashField,
  hashUiText,
  InMemoryConsentLedger,
  isStateChangingTool,
  MCPGateway,
  renderTaintedObservation,
  snapshotTool,
  taintObservation,
  vetTool,
  vetTools,
} from "@wasmagent/mcp-firewall";

// New mcp-gateway modules
export type { AuditEvent, AuditLogger } from "./audit.js";
export { buildAuditEvent, InMemoryAuditLogger } from "./audit.js";
export type { GatewayMiddleware, MiddlewareContext, NextFn } from "./middleware.js";
export { composeMiddleware, noopMiddleware } from "./middleware.js";
