/**
 * @wasmagent/mcp-firewall — alpha
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
// Consent ledger
export type {
  ConsentAction,
  ConsentEvent,
  ConsentLedger,
} from "./consent.js";
export { hashUiText, InMemoryConsentLedger } from "./consent.js";
// Gateway layer — identity, server card, state-changing action approval
export type {
  GatewayDecision,
  GatewayRequest,
  MCPGatewayOptions,
  RequestIdentity,
  ServerCard,
} from "./gateway.js";
export {
  buildServerCard,
  createRequestIdentity,
  isStateChangingTool,
  MCPGateway,
} from "./gateway.js";
// Per-call policy
export type {
  ConsentRecord,
  InvocationDecision,
  PolicyRule,
  ToolInvocationDecision,
} from "./policy.js";
export {
  ASK_HIGH_RISK_RULE,
  DEFAULT_RULES,
  DENY_BLOCKED_RULE,
  evaluatePolicy,
} from "./policy.js";
// Taint tracking
export type {
  ContentType,
  TaintedObservation,
  TrustLevel,
} from "./taint.js";
export { renderTaintedObservation, taintObservation } from "./taint.js";
// Static vetting
export type {
  RiskCategory,
  RiskRecommendation,
  RiskSeverity,
  ToolRiskFinding,
  VettedField,
  VettingResult,
} from "./vetting.js";
export { vetTool, vetTools } from "./vetting.js";
