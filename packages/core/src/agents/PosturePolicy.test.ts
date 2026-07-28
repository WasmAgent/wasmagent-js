/**
 * PosturePolicy — cross-agent policy inheritance + delegation unit tests.
 *
 * The contract this file asserts:
 *   1. monotonic narrowing: a child can only ever SHRINK its inherited posture.
 *   2. allow-lists intersect, the deny-list unions, recording elevates, cpu shrinks.
 *   3. escalation attempts (child asking for MORE than the parent) are attenuated
 *      AND surfaced in the audit trail.
 *   4. the posture digest is tamper-evident + reproducible.
 *   5. the manifest ↔ posture bridges round-trip.
 *   6. buildPostureDelegationRecord carries all of the above into one record.
 */

import { describe, expect, it } from "bun:test";
import type { CapabilityManifest } from "../executor/types.js";
import {
  buildPostureDelegationRecord,
  inheritPosture,
  manifestFromPosture,
  POSTURE_DELEGATION_TYPE,
  type PosturePolicy,
  postureDigestFor,
  postureFromManifest,
} from "./PosturePolicy.js";

function basePosture(overrides: Partial<PosturePolicy> = {}): PosturePolicy {
  const p: PosturePolicy = {
    allowedHosts: ["api.example.com", "cdn.example.com"],
    allowedReadPaths: ["/workspace", "/data"],
    allowedWritePaths: ["/workspace/out"],
    extraCapabilities: ["tool:web_search", "tool:shell"],
    deniedTools: ["dangerous_tool"],
    recordingMode: "validation",
    ...overrides,
  };
  return p;
}

describe("inheritPosture — monotonic narrowing", () => {
  it("with no override, effective posture equals the parent (deep)", () => {
    const parent = basePosture();
    const { effective, attenuations } = inheritPosture(parent);
    expect(effective).toEqual(parent);
    expect(attenuations).toEqual([]);
    // and the effective is a CLONE — mutating it must not touch the parent.
    effective.allowedHosts.push("evil.example.com");
    expect(parent.allowedHosts).not.toContain("evil.example.com");
  });

  it("allow-lists intersect: child narrows to a subset", () => {
    const parent = basePosture();
    const { effective } = inheritPosture(parent, {
      allowedHosts: ["api.example.com"],
      allowedReadPaths: ["/data"],
    });
    expect(effective.allowedHosts).toEqual(["api.example.com"]);
    expect(effective.allowedReadPaths).toEqual(["/data"]);
    // untouched fields inherit the parent verbatim
    expect(effective.allowedWritePaths).toEqual(["/workspace/out"]);
  });

  it("escalation attempt: child requests items the parent did NOT grant → dropped + attenuated", () => {
    const parent = basePosture();
    const { effective, attenuations } = inheritPosture(parent, {
      allowedHosts: ["api.example.com", "evil.example.com", "exfil.example.com"],
    });
    // only the parent-granted host survives
    expect(effective.allowedHosts).toEqual(["api.example.com"]);
    // the two un-granted hosts are reported as attenuations
    const hostAtt = attenuations.find((a) => a.field === "allowedHosts");
    expect(hostAtt).toBeDefined();
    expect((hostAtt?.requested as string[]).sort()).toEqual([
      "api.example.com",
      "evil.example.com",
      "exfil.example.com",
    ]);
    expect(hostAtt?.granted).toEqual(["api.example.com"]);
    expect(hostAtt?.reason).toContain("evil.example.com");
    expect(hostAtt?.reason).toContain("exfil.example.com");
  });

  it("deny-list only ever grows (union), never shrinks", () => {
    const parent = basePosture({ deniedTools: ["dangerous_tool"] });
    const { effective } = inheritPosture(parent, { deniedTools: ["another_bad_tool"] });
    expect(effective.deniedTools.sort()).toEqual(["another_bad_tool", "dangerous_tool"]);
    // child cannot UN-deny a parent-denied tool
    const { effective: effective2 } = inheritPosture(parent, { deniedTools: [] });
    expect(effective2.deniedTools).toEqual(["dangerous_tool"]);
  });

  it("recording mode elevates to the stricter of parent/child", () => {
    const parent = basePosture({ recordingMode: "validation" });
    expect(inheritPosture(parent, { recordingMode: "delta" }).effective.recordingMode).toBe(
      "delta"
    );
    expect(inheritPosture(parent, { recordingMode: "full" }).effective.recordingMode).toBe("full");
  });

  it("recording mode cannot be lowered below the parent floor (attenuated)", () => {
    const parent = basePosture({ recordingMode: "full" });
    const { effective, attenuations } = inheritPosture(parent, { recordingMode: "validation" });
    expect(effective.recordingMode).toBe("full");
    const recAtt = attenuations.find((a) => a.field === "recordingMode");
    expect(recAtt).toBeDefined();
    expect(recAtt?.requested).toBe("validation");
    expect(recAtt?.granted).toBe("full");
  });

  it("cpu budget shrinks to the smaller ceiling; exceeding the parent is clamped + attenuated", () => {
    const parent = basePosture({ cpuMs: 5000 });
    // narrower budget accepted
    expect(inheritPosture(parent, { cpuMs: 2000 }).effective.cpuMs).toBe(2000);
    // larger budget clamped down to parent
    const { effective, attenuations } = inheritPosture(parent, { cpuMs: 9000 });
    expect(effective.cpuMs).toBe(5000);
    const cpuAtt = attenuations.find((a) => a.field === "cpuMs");
    expect(cpuAtt).toBeDefined();
    expect(cpuAtt?.requested).toBe(9000);
    expect(cpuAtt?.granted).toBe(5000);
  });

  it("child may ADD a cpu budget the parent lacked (still narrowing)", () => {
    const parent = basePosture();
    expect(parent.cpuMs).toBeUndefined();
    const { effective, attenuations } = inheritPosture(parent, { cpuMs: 3000 });
    expect(effective.cpuMs).toBe(3000);
    expect(attenuations).toEqual([]);
  });

  it("a child posture is never BROADER than its parent on any field", () => {
    const parent = basePosture({ recordingMode: "delta", cpuMs: 4000 });
    const { effective } = inheritPosture(parent, {
      allowedHosts: ["api.example.com", "evil.example.com"],
      allowedWritePaths: ["/workspace/out", "/etc"],
      extraCapabilities: ["tool:web_search", "tool:nukes"],
      deniedTools: [],
      recordingMode: "validation",
      cpuMs: 99999,
    });
    // every allow-list is a subset of the parent
    for (const host of effective.allowedHosts) {
      expect(parent.allowedHosts).toContain(host);
    }
    for (const cap of effective.extraCapabilities) {
      expect(parent.extraCapabilities).toContain(cap);
    }
    // deny-list is a superset of parent
    for (const t of parent.deniedTools) {
      expect(effective.deniedTools).toContain(t);
    }
    // recording ≥ parent floor; cpu ≤ parent ceiling
    expect(effective.recordingMode).toBe("delta");
    expect(effective.cpuMs).toBeLessThanOrEqual(parent.cpuMs ?? Number.POSITIVE_INFINITY);
  });
});

describe("postureDigestFor — tamper-evidence", () => {
  it("is reproducible from the same postures", () => {
    const parent = basePosture();
    const { effective } = inheritPosture(parent, { allowedHosts: ["api.example.com"] });
    const d1 = postureDigestFor({
      parentAgentId: "p",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: effective,
    });
    const d2 = postureDigestFor({
      parentAgentId: "p",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: effective,
    });
    expect(d1).toBe(d2);
    expect(d1).toHaveLength(64);
  });

  it("is order-independent (allow-list element order does not change the digest)", () => {
    const parent = basePosture();
    const a = postureDigestFor({
      parentAgentId: "p",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: { ...parent, allowedHosts: ["cdn.example.com", "api.example.com"] },
    });
    const b = postureDigestFor({
      parentAgentId: "p",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: { ...parent, allowedHosts: ["api.example.com", "cdn.example.com"] },
    });
    expect(a).toBe(b);
  });

  it("changes when the effective posture changes", () => {
    const parent = basePosture();
    const d1 = postureDigestFor({
      parentAgentId: "p",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: { ...parent, recordingMode: "validation" },
    });
    const d2 = postureDigestFor({
      parentAgentId: "p",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: { ...parent, recordingMode: "full" },
    });
    expect(d1).not.toBe(d2);
  });

  it("changes when the agents involved change", () => {
    const parent = basePosture();
    const d1 = postureDigestFor({
      parentAgentId: "p1",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: parent,
    });
    const d2 = postureDigestFor({
      parentAgentId: "p2",
      childAgentId: "c",
      parentPosture: parent,
      effectivePosture: parent,
    });
    expect(d1).not.toBe(d2);
  });
});

describe("postureFromManifest / manifestFromPosture — bridges", () => {
  const manifest: CapabilityManifest = {
    allowedHosts: ["api.example.com"],
    allowedReadPaths: ["/workspace"],
    allowedWritePaths: ["/workspace/out"],
    extraCapabilities: ["tool:web_search"],
    cpuMs: 5000,
  };

  it("lifts a manifest into a posture with a validation floor by default", () => {
    const posture = postureFromManifest(manifest);
    expect(posture.allowedHosts).toEqual(["api.example.com"]);
    expect(posture.extraCapabilities).toEqual(["tool:web_search"]);
    expect(posture.cpuMs).toBe(5000);
    expect(posture.recordingMode).toBe("validation");
    expect(posture.deniedTools).toEqual([]);
  });

  it("round-trips manifest → posture → manifest losslessly (modulo posture-only fields)", () => {
    const posture = postureFromManifest(manifest, {
      recordingMode: "full",
      deniedTools: ["x"],
    });
    const back = manifestFromPosture(posture);
    expect(back).toEqual(manifest);
    // deny-list + recording mode are posture-only — not manifest fields
    expect(back).not.toHaveProperty("deniedTools");
    expect(back).not.toHaveProperty("recordingMode");
  });
});

describe("buildPostureDelegationRecord", () => {
  it("binds parent → effective posture with a reproducible digest + audit trail", () => {
    const parent = basePosture({ recordingMode: "full", cpuMs: 5000 });
    const rec = buildPostureDelegationRecord({
      parentAgentId: "parent-agent",
      childAgentId: "child-agent",
      delegationChain: ["root", "parent-agent"],
      parentPosture: parent,
      childOverride: { allowedHosts: ["api.example.com", "evil.example.com"], cpuMs: 9000 },
    });

    expect(rec.type).toBe(POSTURE_DELEGATION_TYPE);
    expect(rec.parentAgentId).toBe("parent-agent");
    expect(rec.childAgentId).toBe("child-agent");
    expect(rec.delegationChain).toEqual(["root", "parent-agent"]);
    // effective is the narrowed posture
    expect(rec.effectivePosture.allowedHosts).toEqual(["api.example.com"]);
    expect(rec.effectivePosture.cpuMs).toBe(5000);
    // both escalation attempts surfaced
    const fields = rec.attenuations.map((a) => a.field).sort();
    expect(fields).toEqual(["allowedHosts", "cpuMs"]);
    // digest reproducible from the record's own fields (the auditor check)
    expect(rec.postureDigest).toBe(
      postureDigestFor({
        parentAgentId: rec.parentAgentId,
        childAgentId: rec.childAgentId,
        parentPosture: rec.parentPosture,
        effectivePosture: rec.effectivePosture,
      })
    );
  });

  it("records no attenuation when the child only narrows", () => {
    const parent = basePosture();
    const rec = buildPostureDelegationRecord({
      parentAgentId: "p",
      childAgentId: "c",
      delegationChain: [],
      parentPosture: parent,
      childOverride: { allowedHosts: ["api.example.com"], recordingMode: "full" },
    });
    expect(rec.attenuations).toEqual([]);
    expect(rec.effectivePosture.allowedHosts).toEqual(["api.example.com"]);
    expect(rec.effectivePosture.recordingMode).toBe("full");
  });

  it("does not mutate the caller's parent posture after building", () => {
    const parent = basePosture();
    const original = [...parent.allowedHosts];
    buildPostureDelegationRecord({
      parentAgentId: "p",
      childAgentId: "c",
      delegationChain: [],
      parentPosture: parent,
      childOverride: { allowedHosts: ["api.example.com"] },
    });
    expect(parent.allowedHosts).toEqual(original);
  });
});
