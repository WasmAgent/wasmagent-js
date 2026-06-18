/**
 * F4 — AGENTS.md loader tests.
 *
 * Pin down the v3 contract:
 *   1. nearest-AGENTS.md wins, but broader files are kept (LLM "later
 *      instructions override" bias);
 *   2. with no AGENTS.md anywhere, output is the empty string — consumers
 *      can inject it unconditionally without polluting the prompt;
 *   3. monorepo case: editing a file under packages/api/ pulls in the
 *      packages/api/AGENTS.md plus the root one, in the right order;
 *   4. catalog is cached: repeated forPath() calls do not re-enumerate the
 *      KV (asserted with a counting backend);
 *   5. per-file size cap is honoured and the truncation is announced;
 *   6. KV adapter respects the configured filePrefix and ignores non-md keys;
 *   7. file order in the catalog is deterministic — same content, same bytes
 *      (prompt-cache stability requirement).
 */

import type { KvBackend } from "../checkpoint/index.js";
import { MapKvBackend } from "../memory/MemoryTool.js";
import { AGENTS_MD_FILENAME, makeKvAgentsMdLoader, ProjectInstructions } from "./agentsMd.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

class CountingKv implements KvBackend {
  listCount = 0;
  getCount = 0;
  constructor(private readonly inner: MapKvBackend) {}
  get(k: string) {
    this.getCount++;
    return this.inner.get(k);
  }
  put(k: string, v: string) {
    return this.inner.put(k, v);
  }
  delete(k: string) {
    return this.inner.delete(k);
  }
  list(prefix: string) {
    this.listCount++;
    return this.inner.list(prefix);
  }
}

async function seed(kv: KvBackend, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await kv.put(`file:${path}`, content);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AGENTS.md filename constant", () => {
  it("matches the published spec", () => {
    expect(AGENTS_MD_FILENAME).toBe("AGENTS.md");
  });
});

describe("ProjectInstructions — empty workspace", () => {
  it("returns empty text + no sources when no AGENTS.md exists anywhere", async () => {
    const kv = new MapKvBackend();
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv) });
    const out = await pi.forPath("packages/api/src/index.ts");
    expect(out).toEqual({ text: "", sources: [], truncated: false });
  });

  it("returns empty when AGENTS.md is in a non-ancestor directory of the target", async () => {
    const kv = new MapKvBackend();
    await seed(kv, {
      // AGENTS.md exists, but only under packages/db/. Editing packages/api/
      // should NOT pull it in.
      "packages/db/AGENTS.md": "DB rules",
    });
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv) });
    const out = await pi.forPath("packages/api/src/index.ts");
    expect(out.sources).toEqual([]);
    expect(out.text).toBe("");
  });
});

describe("ProjectInstructions — root file", () => {
  it("loads the repo-root AGENTS.md and emits header + footer", async () => {
    const kv = new MapKvBackend();
    await seed(kv, { "AGENTS.md": "# Build\n\n`pnpm test` to run." });
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv) });
    const out = await pi.forPath("packages/api/src/index.ts");
    expect(out.sources).toEqual(["AGENTS.md"]);
    expect(out.text).toContain("# Project instructions (AGENTS.md)");
    expect(out.text).toContain("`pnpm test` to run.");
    expect(out.text).toContain("# End project instructions");
    expect(out.truncated).toBe(false);
  });

  it("forRepo() === forPath('') — the convenience name resolves the root view", async () => {
    const kv = new MapKvBackend();
    await seed(kv, { "AGENTS.md": "root rules" });
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv) });
    const a = await pi.forRepo();
    const b = await pi.forPath("");
    expect(a).toEqual(b);
    expect(a.text).toContain("root rules");
  });
});

describe("ProjectInstructions — nesting and 'nearest wins'", () => {
  it("monorepo: editing packages/api/ pulls api's AGENTS.md plus the root one", async () => {
    const kv = new MapKvBackend();
    await seed(kv, {
      "AGENTS.md": "ROOT-RULES",
      "packages/api/AGENTS.md": "API-RULES",
      "packages/db/AGENTS.md": "DB-RULES",
    });
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv) });
    const out = await pi.forPath("packages/api/src/handler.ts");
    expect(out.sources).toEqual(["AGENTS.md", "packages/api/AGENTS.md"]);
    // DB rules MUST NOT leak in.
    expect(out.text).not.toContain("DB-RULES");
    // Order: broadest first, nearest last (LLM "later wins" bias).
    const rootIdx = out.text.indexOf("ROOT-RULES");
    const apiIdx = out.text.indexOf("API-RULES");
    expect(rootIdx).toBeGreaterThan(-1);
    expect(apiIdx).toBeGreaterThan(rootIdx);
  });

  it("triple-nested: walk root → mid → leaf and keep all three", async () => {
    const kv = new MapKvBackend();
    await seed(kv, {
      "AGENTS.md": "L0",
      "packages/AGENTS.md": "L1",
      "packages/api/AGENTS.md": "L2",
    });
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv) });
    const out = await pi.forPath("packages/api/src/handler.ts");
    expect(out.sources).toEqual(["AGENTS.md", "packages/AGENTS.md", "packages/api/AGENTS.md"]);
    const i0 = out.text.indexOf("L0");
    const i1 = out.text.indexOf("L1");
    const i2 = out.text.indexOf("L2");
    expect(i0).toBeLessThan(i1);
    expect(i1).toBeLessThan(i2);
  });

  it("maxFiles cap drops broadest files first; deepest are kept", async () => {
    const kv = new MapKvBackend();
    await seed(kv, {
      "AGENTS.md": "L0",
      "a/AGENTS.md": "L1",
      "a/b/AGENTS.md": "L2",
      "a/b/c/AGENTS.md": "L3",
    });
    const pi = new ProjectInstructions({
      loader: makeKvAgentsMdLoader(kv),
      maxFiles: 2,
    });
    const out = await pi.forPath("a/b/c/d.ts");
    // Only the two deepest survive: a/b/AGENTS.md and a/b/c/AGENTS.md.
    expect(out.sources).toEqual(["a/b/AGENTS.md", "a/b/c/AGENTS.md"]);
    expect(out.text).not.toContain("L0");
    expect(out.text).not.toContain("L1");
    expect(out.text).toContain("L2");
    expect(out.text).toContain("L3");
  });
});

describe("ProjectInstructions — truncation", () => {
  it("respects maxFileChars and announces the truncation", async () => {
    const kv = new MapKvBackend();
    const big = "x".repeat(20_000);
    await seed(kv, { "AGENTS.md": big });
    const pi = new ProjectInstructions({
      loader: makeKvAgentsMdLoader(kv),
      maxFileChars: 100,
    });
    const out = await pi.forPath("");
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("[truncated]");
    // The slice is bounded — text body has at most ~100 x's, not 20000.
    expect(out.text.length).toBeLessThan(500);
  });
});

describe("ProjectInstructions — caching", () => {
  it("catalog is enumerated only once across many forPath() calls", async () => {
    const inner = new MapKvBackend();
    const counter = new CountingKv(inner);
    await seed(counter, {
      "AGENTS.md": "root",
      "packages/api/AGENTS.md": "api",
    });
    const before = counter.listCount;
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(counter) });

    await pi.forPath("packages/api/src/a.ts");
    await pi.forPath("packages/api/src/b.ts");
    await pi.forPath("packages/api/src/c.ts");
    const listsByForPath = counter.listCount - before;
    expect(listsByForPath).toBe(1);

    pi.invalidate();
    await pi.forPath("packages/api/src/d.ts");
    expect(counter.listCount - before).toBe(2); // exactly one re-list
  });
});

describe("ProjectInstructions — determinism (prompt-cache safety)", () => {
  it("identical workspace content produces byte-identical output", async () => {
    const kvA = new MapKvBackend();
    const kvB = new MapKvBackend();
    // Insert in different orders to flush out any reliance on insertion order.
    await seed(kvA, {
      "packages/api/AGENTS.md": "api",
      "AGENTS.md": "root",
      "packages/AGENTS.md": "mid",
    });
    await seed(kvB, {
      "AGENTS.md": "root",
      "packages/AGENTS.md": "mid",
      "packages/api/AGENTS.md": "api",
    });
    const a = await new ProjectInstructions({ loader: makeKvAgentsMdLoader(kvA) }).forPath(
      "packages/api/x.ts"
    );
    const b = await new ProjectInstructions({ loader: makeKvAgentsMdLoader(kvB) }).forPath(
      "packages/api/x.ts"
    );
    expect(a.text).toBe(b.text);
    expect(a.sources).toEqual(b.sources);
  });
});

describe("makeKvAgentsMdLoader", () => {
  it("ignores files that are not named AGENTS.md", async () => {
    const kv = new MapKvBackend();
    await seed(kv, {
      "AGENTS.md": "good",
      "agents.md": "wrong-case-must-be-ignored",
      "packages/AGENTS.md.bak": "wrong-suffix-must-be-ignored",
      "packages/notes.md": "unrelated",
    });
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv) });
    const out = await pi.forPath("packages/x.ts");
    expect(out.sources).toEqual(["AGENTS.md"]);
  });

  it("respects a custom filePrefix", async () => {
    const kv = new MapKvBackend();
    await kv.put("ws:AGENTS.md", "alt-prefix");
    const pi = new ProjectInstructions({ loader: makeKvAgentsMdLoader(kv, { filePrefix: "ws:" }) });
    const out = await pi.forRepo();
    expect(out.sources).toEqual(["AGENTS.md"]);
    expect(out.text).toContain("alt-prefix");
  });

  it("rejects a KvBackend without list()", () => {
    const noList: KvBackend = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    };
    expect(() => makeKvAgentsMdLoader(noList)).toThrow(/list/);
  });
});
