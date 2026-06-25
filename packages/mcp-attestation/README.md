# @wasmagent/mcp-attestation

> **Maturity: alpha (v0.1.0)** — capability attestation for MCP servers.

Register and verify capability attestations for MCP tools — know which tools are attested to which level before allowing them through the firewall.

```bash
npm install @wasmagent/mcp-attestation @wasmagent/mcp-firewall
```

---

## What it does

An attestation is a signed claim that an MCP server has been reviewed and its tools are considered safe for a given capability scope. `@wasmagent/mcp-attestation` provides the data model and registry — full PKI signing can be layered on top via Sigstore.

---

## Attestation levels

| Level | Meaning |
|---|---|
| `self` | The server operator attests their own tools |
| `community` | An open-source community review |
| `operator` | A deploying organization's security review |
| `audited` | An independent security audit |

Levels are ordered: `self < community < operator < audited`. `hasAttestation(serverId, "operator")` matches `operator` and `audited`.

---

## Usage

```ts
import { buildAttestation, AttestationRegistry, isAttestationValid } from "@wasmagent/mcp-attestation";
import { buildServerCard } from "@wasmagent/mcp-firewall";

const card = buildServerCard({
  serverId: "my-mcp-server",
  displayName: "My MCP Server",
  tools: [toolEntry],
  operatorVerified: true,
});

const attestation = buildAttestation({
  card,
  level: "operator",
  capabilities: ["read_file", "write_file"],
  attestedBy: "security-team@my-org",
  expiresAt: "2027-01-01T00:00:00Z",
  notes: "Reviewed 2026-06-25, no critical findings",
});

const registry = new AttestationRegistry();
registry.register(attestation);

if (!registry.hasAttestation("my-mcp-server", "operator")) {
  throw new Error("Server not attested at operator level");
}

const attestations = registry.lookupByServer("my-mcp-server");
console.log(isAttestationValid(attestations[0]));  // true
```

---

## API

```ts
type AttestationLevel = "self" | "community" | "operator" | "audited"

interface CapabilityAttestation {
  attestationId: string        // sha256-derived 16-char id
  serverId: string
  toolManifestDigest: string   // from ServerCard.toolManifestDigest
  level: AttestationLevel
  capabilities: string[]
  attestedBy: string
  attestedAt: string           // ISO 8601
  expiresAt?: string
  notes?: string
}

function buildAttestation(opts): CapabilityAttestation
function isAttestationValid(att: CapabilityAttestation): boolean

class AttestationRegistry {
  register(att: CapabilityAttestation): void
  lookupByServer(serverId: string): CapabilityAttestation[]  // only valid (non-expired)
  hasAttestation(serverId: string, level: AttestationLevel): boolean
}
```

---

## Related packages

- [`@wasmagent/mcp-firewall`](../mcp-firewall/README.md) — enforcement layer; `buildServerCard` used in attestation
- [`@wasmagent/mcp-policy`](../mcp-policy/README.md) — policy bundles to pair with attestations
- [`@wasmagent/aep`](../aep/README.md) — include attestation digests in AEP evidence records

## License

Apache-2.0
