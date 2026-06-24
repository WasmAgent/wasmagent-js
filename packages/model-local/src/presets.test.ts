/**
 * Routing-preset tests — make sure the wrappers are pure relabels of the
 * underlying FallbackModel and don't introduce new behaviour.
 */

import { FallbackModel, type Model } from "@wasmagent/core/models";
import { devLocalOr, localFirst, offlineOnly } from "./presets.js";

const okModel = (id: string, output: string): Model => ({
  providerId: id,
  capabilities: { localEndpoint: id.includes("local") },
  async *generate() {
    yield { type: "text_delta", delta: output } as const;
    yield { type: "stop", stopReason: "end_turn" } as const;
  },
});

const failingModel = (id: string): Model => ({
  providerId: id,
  // biome-ignore lint/correctness/useYield: this generator throws immediately to simulate an unhealthy provider — it never yields by design
  async *generate() {
    throw new Error(`${id} down`);
  },
});

describe("localFirst", () => {
  it("returns a FallbackModel with the local model in slot 0", () => {
    const local = okModel("local", "from-local");
    const cloud = okModel("cloud", "from-cloud");
    const m = localFirst(local, cloud);
    expect(m).toBeInstanceOf(FallbackModel);
    expect(m.providerId).toBe("local");
  });

  it("hands over to the cloud model when local fails before any chunk", async () => {
    const local = failingModel("local");
    const cloud = okModel("cloud", "fallback-output");
    const m = localFirst(local, cloud);
    let text = "";
    for await (const ev of m.generate([{ role: "user", content: "go" }])) {
      if (ev.type === "text_delta") text += ev.delta ?? "";
    }
    expect(text).toBe("fallback-output");
    expect(m.lastActiveProviderId).toBe("cloud");
  });

  it("merges local capability flags onto the FallbackModel", () => {
    const local = okModel("local-1", "x");
    const cloud = okModel("cloud-1", "y");
    const m = localFirst(local, cloud);
    expect(m.capabilities?.localEndpoint).toBe(true);
  });
});

describe("offlineOnly", () => {
  it("is a passthrough for the local model", async () => {
    const local = okModel("local-x", "ok");
    const m = offlineOnly(local);
    expect(m.providerId).toBe("local-x");
    let text = "";
    for await (const ev of m.generate([{ role: "user", content: "?" }])) {
      if (ev.type === "text_delta") text += ev.delta ?? "";
    }
    expect(text).toBe("ok");
  });
});

describe("devLocalOr", () => {
  const orig = process.env.WASMAGENT_DEV_LOCAL;
  afterEach(() => {
    if (orig === undefined) delete process.env.WASMAGENT_DEV_LOCAL;
    else process.env.WASMAGENT_DEV_LOCAL = orig;
  });

  it("returns the local model when WASMAGENT_DEV_LOCAL=1", () => {
    process.env.WASMAGENT_DEV_LOCAL = "1";
    const local = okModel("L", "");
    const cloud = okModel("C", "");
    expect(devLocalOr(local, cloud).providerId).toBe("L");
  });

  it("returns the cloud model when WASMAGENT_DEV_LOCAL is unset", () => {
    delete process.env.WASMAGENT_DEV_LOCAL;
    const local = okModel("L", "");
    const cloud = okModel("C", "");
    expect(devLocalOr(local, cloud).providerId).toBe("C");
  });
});
