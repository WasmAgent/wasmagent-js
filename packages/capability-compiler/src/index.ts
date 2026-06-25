/**
 * @wasmagent/capability-compiler — alpha
 *
 * Compile a CapabilityManifest into three targets:
 *
 *   1. MCP tool schema fragment (compileToMcpSchema)
 *      → JSON Schema properties + documentation table + capability tags
 *
 *   2. Runtime policy rules (compileToPolicy)
 *      → deterministic allow/deny/warn per tool call, no ML
 *
 *   3. Trace validator spec (compileToTraceValidator)
 *      → checks a recorded ADP trace for manifest violations
 *
 * @example
 * ```ts
 * import { compileToMcpSchema, compileToPolicy, compileToTraceValidator } from "@wasmagent/capability-compiler";
 *
 * const manifest = { allowedHosts: [], allowedReadPaths: ["/workspace"], allowedWritePaths: ["/workspace"], extraCapabilities: [], cpuMs: 3000 };
 *
 * const { documentationTable, capabilityTags } = compileToMcpSchema(manifest, "edit_file");
 * const policy = compileToPolicy(manifest);
 * const decision = policy.evaluate({ toolName: "write_file", args: {}, resolvedPath: "/workspace/foo.ts" });
 * const validator = compileToTraceValidator(manifest);
 * const violations = validator.validate(trace);
 * ```
 */

export type { McpCapabilitySchema } from "./mcpSchema.js";
export { compileToMcpSchema } from "./mcpSchema.js";

export type {
  CompiledPolicy,
  PolicyCheckResult,
  PolicyOutcome,
  PolicyRule,
  ToolCall,
} from "./policy.js";
export { compileToPolicy } from "./policy.js";

export type {
  TraceStep,
  TraceValidatorSpec,
  TraceViolation,
} from "./traceValidator.js";
export { compileToTraceValidator } from "./traceValidator.js";
