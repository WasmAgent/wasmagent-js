/**
 * PolicyBundle — a named, versioned collection of PolicyRules.
 *
 * Bundles are the unit of policy distribution: you publish a bundle,
 * register it in the Evidence Registry, and reference it by digest in AEP records.
 */
import { createHash } from "node:crypto";
import type { PolicyRule } from "@wasmagent/mcp-firewall";
import { ASK_HIGH_RISK_RULE, DEFAULT_RULES, DENY_BLOCKED_RULE } from "@wasmagent/mcp-firewall";

export interface PolicyBundleMetadata {
  id: string;
  version: string;
  description: string;
  createdAt: string;
}

export class PolicyBundle {
  readonly metadata: PolicyBundleMetadata;
  readonly #rules: PolicyRule[];

  constructor(metadata: PolicyBundleMetadata, rules: PolicyRule[]) {
    this.metadata = metadata;
    this.#rules = [...rules];
  }

  get rules(): PolicyRule[] {
    return [...this.#rules];
  }

  get digest(): string {
    const canonical = JSON.stringify({
      id: this.metadata.id,
      version: this.metadata.version,
      ruleIds: this.#rules.map((r) => r.policyId).sort(),
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  static default(): PolicyBundle {
    return new PolicyBundle(
      {
        id: "wasmagent-default",
        version: "1.0.0",
        description: "Default WasmAgent MCP policy bundle",
        createdAt: new Date().toISOString(),
      },
      DEFAULT_RULES
    );
  }

  static strict(): PolicyBundle {
    return new PolicyBundle(
      {
        id: "wasmagent-strict",
        version: "1.0.0",
        description: "Strict policy: deny all high-risk, ask for medium",
        createdAt: new Date().toISOString(),
      },
      [DENY_BLOCKED_RULE, ASK_HIGH_RISK_RULE]
    );
  }

  extend(additionalRules: PolicyRule[]): PolicyBundle {
    return new PolicyBundle(this.metadata, [...this.#rules, ...additionalRules]);
  }
}
