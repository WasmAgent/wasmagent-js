# @wasmagent/mcp-policy

> **Maturity: alpha (v0.1.0)** — policy bundle composition for MCP agents.

Compose, version, and load reusable policy rule bundles for `@wasmagent/mcp-firewall`.

```bash
npm install @wasmagent/mcp-policy @wasmagent/mcp-firewall
```

---

## What it does

`@wasmagent/mcp-policy` provides `PolicyBundle` — a named, versioned, content-addressed collection of `PolicyRule`s. Bundles are the unit of policy distribution: publish a bundle, reference it by digest in AEP records, and load it into `evaluatePolicy`.

---

## Usage

```ts
import { PolicyBundle } from "@wasmagent/mcp-policy";
import { evaluatePolicy } from "@wasmagent/mcp-firewall";

// Built-in bundles
const defaultBundle = PolicyBundle.default();  // DENY_BLOCKED + DEFAULT_RULES
const strictBundle  = PolicyBundle.strict();   // DENY_BLOCKED + ASK_HIGH_RISK

// Custom bundle
const customBundle = new PolicyBundle(
  {
    id: "my-app-policy",
    version: "1.0.0",
    description: "Custom policy for my application",
    createdAt: new Date().toISOString(),
  },
  [
    ...defaultBundle.rules,
    // add custom PolicyRule entries here
  ]
);

// Content-addressed digest — store in AEP records for audit trail
console.log(customBundle.digest);  // sha256 hex of canonical bundle

// Extend an existing bundle
const extended = defaultBundle.extend([myCustomRule]);

// Use with mcp-firewall
const decision = evaluatePolicy(toolName, args, vetting, consentRecords, strictBundle.rules);
```

---

## API

### `PolicyBundle`

```ts
class PolicyBundle {
  readonly metadata: PolicyBundleMetadata;
  get rules(): PolicyRule[]
  get digest(): string          // sha256 of canonical {id, version, ruleIds[]}
  extend(rules: PolicyRule[]): PolicyBundle
  static default(): PolicyBundle
  static strict(): PolicyBundle
}

interface PolicyBundleMetadata {
  id: string;
  version: string;
  description: string;
  createdAt: string;
}
```

### Re-exported from `@wasmagent/mcp-firewall`

```ts
export { evaluatePolicy, DEFAULT_RULES, DENY_BLOCKED_RULE, ASK_HIGH_RISK_RULE }
export type { PolicyRule }
```

---

## Related packages

- [`@wasmagent/mcp-firewall`](../mcp-firewall/README.md) — the enforcement engine this policy feeds into
- [`@wasmagent/mcp-gateway`](../mcp-gateway/README.md) — identity-aware gateway that applies policy bundles
- [`@wasmagent/mcp-attestation`](../mcp-attestation/README.md) — pair attestation with policy bundles

## License

Apache-2.0
