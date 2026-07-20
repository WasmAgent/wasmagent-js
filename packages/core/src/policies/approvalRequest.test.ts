import { describe, expect, it } from "bun:test";

import type { ApprovalRequest } from "./approvalRequest.js";
import { CloudflareKvApprovalStore } from "./approvalStoreKv.js";
import { InMemoryApprovalStore } from "./approvalStoreMemory.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "req-001",
    agentId: "agent-a",
    runId: "run-1",
    toolName: "write_file",
    op: "write",
    path: "src/foo.ts",
    contextSummary: "Creating a new module",
    requestedAt: "2026-07-19T10:00:00Z",
    status: "pending",
    ...overrides,
  };
}

// ── InMemoryApprovalStore ───────────────────────────────────────────────────

describe("InMemoryApprovalStore", () => {
  it("put + get round-trips a request", async () => {
    const store = new InMemoryApprovalStore();
    const req = makeRequest();
    await store.put(req);
    const retrieved = await store.get("req-001");
    expect(retrieved).toEqual(req);
  });

  it("get returns null for unknown id", async () => {
    const store = new InMemoryApprovalStore();
    expect(await store.get("nonexistent")).toBeNull();
  });

  it("update records decision and changes status", async () => {
    const store = new InMemoryApprovalStore();
    await store.put(makeRequest());

    await store.update("req-001", {
      status: "approved",
      decidedAt: "2026-07-19T10:05:00Z",
      reviewer: "human-1",
      reason: "Looks good",
    });

    const updated = await store.get("req-001");
    expect(updated?.status).toBe("approved");
    expect(updated?.decision).toEqual({
      decidedAt: "2026-07-19T10:05:00Z",
      reviewer: "human-1",
      reason: "Looks good",
    });
  });

  it("update throws if request does not exist", async () => {
    const store = new InMemoryApprovalStore();
    await expect(
      store.update("missing", {
        status: "rejected",
        decidedAt: "2026-07-19T10:05:00Z",
        reviewer: "human-1",
      })
    ).rejects.toThrow("ApprovalRequest missing not found");
  });

  it("getAll returns all stored requests", async () => {
    const store = new InMemoryApprovalStore();
    await store.put(makeRequest({ requestId: "r1" }));
    await store.put(makeRequest({ requestId: "r2" }));
    expect(store.getAll()).toHaveLength(2);
  });

  it("put throws TypeError when called with a string argument (misuse guard #90)", async () => {
    const store = new InMemoryApprovalStore();
    await expect(
      // Simulate JS misuse: store.put(id, request) — first arg is a string
      (store.put as any)("some-id")
    ).rejects.toThrow(TypeError);
  });

  it("put throws TypeError when called with null", async () => {
    const store = new InMemoryApprovalStore();
    await expect((store.put as any)(null)).rejects.toThrow(TypeError);
  });

  it("put throws TypeError when called with an object missing requestId", async () => {
    const store = new InMemoryApprovalStore();
    await expect(
      (store.put as any)({ agentId: "a", runId: "r", toolName: "t", op: "o" })
    ).rejects.toThrow(TypeError);
  });
});

// ── CloudflareKvApprovalStore ───────────────────────────────────────────────

function createMockKv(): {
  kv: { get: (k: string) => Promise<string | null>; put: (k: string, v: string) => Promise<void> };
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    kv: {
      async get(key: string) {
        return data.get(key) ?? null;
      },
      async put(key: string, value: string) {
        data.set(key, value);
      },
    },
  };
}

describe("CloudflareKvApprovalStore", () => {
  it("put + get round-trips a request through KV", async () => {
    const { kv } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv);
    const req = makeRequest();
    await store.put(req);
    const retrieved = await store.get("req-001");
    expect(retrieved).toEqual(req);
  });

  it("get returns null for unknown id", async () => {
    const { kv } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv);
    expect(await store.get("nonexistent")).toBeNull();
  });

  it("update records decision in KV", async () => {
    const { kv } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv);
    await store.put(makeRequest());

    await store.update("req-001", {
      status: "rejected",
      decidedAt: "2026-07-19T10:10:00Z",
      reviewer: "admin",
      reason: "Too risky",
    });

    const updated = await store.get("req-001");
    expect(updated?.status).toBe("rejected");
    expect(updated?.decision?.reviewer).toBe("admin");
    expect(updated?.decision?.reason).toBe("Too risky");
  });

  it("update throws if request does not exist in KV", async () => {
    const { kv } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv);
    await expect(
      store.update("missing", {
        status: "approved",
        decidedAt: "2026-07-19T10:10:00Z",
        reviewer: "admin",
      })
    ).rejects.toThrow("ApprovalRequest missing not found");
  });

  it("uses custom prefix for KV keys", async () => {
    const { kv, data } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv, "custom:");
    await store.put(makeRequest({ requestId: "r42" }));
    expect(data.has("custom:r42")).toBe(true);
    expect(data.has("approval:r42")).toBe(false);
  });

  it("put throws TypeError when called with a string argument (misuse guard #90)", async () => {
    const { kv } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv);
    await expect((store.put as any)("some-id")).rejects.toThrow(TypeError);
  });

  it("put throws TypeError when called with null", async () => {
    const { kv } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv);
    await expect((store.put as any)(null)).rejects.toThrow(TypeError);
  });

  it("put throws TypeError when called with an object missing requestId", async () => {
    const { kv } = createMockKv();
    const store = new CloudflareKvApprovalStore(kv);
    await expect(
      (store.put as any)({ agentId: "a", runId: "r", toolName: "t", op: "o" })
    ).rejects.toThrow(TypeError);
  });
});
