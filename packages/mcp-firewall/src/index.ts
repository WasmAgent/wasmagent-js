/**
 * @wasmagent/mcp-firewall — beta
 *
 * Runtime firewall for MCP and tool-augmented agents.
 * Deterministic enforcement — no ML required.
 *
 * ## Layers
 *
 *   1. **Snapshot + rug-pull** (from `@wasmagent/mcp-server`):
 *      Hash tool descriptors at first-seen time; detect descriptor drift.
 *
 *   2. **Static vetting** (`vetTool`):
 *      Scan name, description, and inputSchema for injection patterns,
 *      exfiltration keywords, invisible characters, and sampling abuse.
 *
 *   3. **Per-call policy** (`evaluatePolicy`):
 *      Combine vetting result + consent records → allow / deny / ask_user / dry_run.
 *
 *   4. **Taint tracking** (`taintObservation`):
 *      Wrap tool results in typed boundary before prompt assembly.
 *
 *   5. **Consent ledger** (`InMemoryConsentLedger`):
 *      Record and query user approvals scoped to tool snapshot hashes.
 *
 * @example
 * ```ts
 * import { vetTool, evaluatePolicy, taintObservation, snapshotTool } from "@wasmagent/mcp-firewall";
 *
 * // Before calling any tool
 * const snap = snapshotTool(entry, serverId);
 * const vetting = vetTool(entry);
 * const decision = evaluatePolicy(entry.name, args, vetting, []);
 * if (decision.decision === "deny") throw new Error("Tool blocked by firewall");
 *
 * // After receiving tool result
 * const obs = taintObservation(entry.name, rawResult);
 * const promptText = renderTaintedObservation(obs, rawResult);
 * ```
 */

// Re-export snapshot + rug-pull from mcp-server (P0 foundation)
export type {
  ToolDescriptorSnapshot,
  ToolRugPullEvent,
  TrustTier,
} from "@wasmagent/mcp-server";
export { detectRugPull, hashContent, snapshotTool } from "@wasmagent/mcp-server";
// Capability and tenant enforcement
export type { CapabilityEnvelope, CapabilityGrant, EffectClass } from "./capability.js";
export {
  CapabilityRegistry,
  classifyEffect,
  detectCrossTenantAccess,
  makeCapabilityPolicyRule,
  makeTenantIsolationRule,
  requiredCapabilityForEffect,
} from "./capability.js";
// Consent ledger
export type {
  ConsentAction,
  ConsentCacheKey,
  ConsentEvent,
  ConsentLedger,
} from "./consent.js";
export { hashArgScope, hashField, hashUiText, InMemoryConsentLedger } from "./consent.js";
// Gateway layer — identity, server card, scope lease, approval receipt, state-changing action approval
export type {
  ApprovalReceipt,
  GatewayDecision,
  GatewayRequest,
  MCPGatewayOptions,
  RequestIdentity,
  ScopeLease,
  ServerCard,
} from "./gateway.js";
export {
  buildServerCard,
  createApprovalReceipt,
  createRequestIdentity,
  createScopeLease,
  isScopeLeaseValid,
  isStateChangingTool,
  MCPGateway,
} from "./gateway.js";
// Observability — metrics counters and verdict-to-metrics mapping
export type {
  FirewallMetricEvent,
  FirewallMetricName,
  FirewallMetricsRecorder,
} from "./observability.js";
export {
  FIREWALL_METRIC_NAMES,
  InMemoryMetricsRecorder,
  verdictToMetrics,
} from "./observability.js";
// Per-call policy
export type {
  ConsentRecord,
  ConsentStore,
  InvocationDecision,
  PolicyRule,
  ToolInvocationDecision,
} from "./policy.js";
export {
  ASK_HIGH_RISK_RULE,
  DEFAULT_RULES,
  DENY_BLOCKED_RULE,
  evaluatePolicy,
  InMemoryConsentStore,
  lookupConsent,
} from "./policy.js";
// Semantic detection (phase 3)
export type {
  SemanticDetectionResult,
  SemanticDetector,
  SemanticDetectorOptions,
} from "./semanticDetector.js";
export { DEFAULT_MALICIOUS_CORPUS } from "./semanticDetector.js";
export { TfidfSemanticDetector } from "./semanticDetectorLocal.js";
// Sink-source structural policy
export type { DataSink, DataSource } from "./sink-policy.js";
export {
  CREDENTIAL_PATH_RULE,
  classifyArgSource,
  classifyToolSinks,
  FULL_DEFAULT_RULES,
  makeSinkAwarePolicyRule,
  SECRET_NETWORK_SINK_RULE,
  SHELL_EXEC_CAPABILITY_RULE,
  SINK_POLICY_RULES,
  SSRF_LOCALHOST_RULE,
} from "./sink-policy.js";
// Taint tracking
export type {
  ContentType,
  RenderedTaintedObservation,
  TaintedObservation,
  TaintLabel,
  TrustLevel,
} from "./taint.js";
export { isTainted, propagateTaint, renderTaintedObservation, taintObservation } from "./taint.js";
// Layered verdict model
export type {
  ConsentVerdict,
  ContainmentVerdict,
  DetectionVerdict,
  FirewallSecurityVerdict,
  PolicyVerdict,
  TaintVerdict,
} from "./verdict.js";
export { composeVerdict } from "./verdict.js";
// Static vetting
export type {
  AdversarialHit,
  AdversarialResult,
  FindingType,
  RiskCategory,
  RiskRecommendation,
  RiskSeverity,
  ToolRiskFinding,
  VetToolOptions,
  VettedField,
  VettingResult,
} from "./vetting.js";
export {
  buildVettingCacheKey,
  evaluateAdversarial,
  vetTool,
  vetToolAsync,
  vetTools,
} from "./vetting.js";
