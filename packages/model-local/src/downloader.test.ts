/**
 * Downloader tests — exercise multi-source fallover, sha256 verification,
 * cache hits, and atomic writes via a fully mocked fetch implementation.
 * No real network calls.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSha256,
  defaultCacheDir,
  downloadGGUF,
  downloadUrl,
  effectiveMirror,
  filenameForSource,
} from "./downloader.js";
import type { RegisteredModel } from "./registry.js";
import { LocalModelChecksumError, LocalModelDownloadError } from "./types.js";

let dir: string;
const ORIGINAL_ENV_DIR = process.env.AGENTKIT_MODEL_DIR;
const ORIGINAL_ENV_MIRROR = process.env.AGENTKIT_MODEL_MIRROR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentkit-modeldl-"));
  delete process.env.AGENTKIT_MODEL_DIR;
  delete process.env.AGENTKIT_MODEL_MIRROR;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (ORIGINAL_ENV_DIR === undefined) delete process.env.AGENTKIT_MODEL_DIR;
  else process.env.AGENTKIT_MODEL_DIR = ORIGINAL_ENV_DIR;
  if (ORIGINAL_ENV_MIRROR === undefined) delete process.env.AGENTKIT_MODEL_MIRROR;
  else process.env.AGENTKIT_MODEL_MIRROR = ORIGINAL_ENV_MIRROR;
});

function sha256Of(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function makeFetchImpl(
  routes: Record<string, { status?: number; body?: Uint8Array; throw?: Error }>
): typeof fetch {
  return async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const r = routes[u];
    if (!r) {
      throw new Error(`Unmocked URL: ${u}`);
    }
    if (r.throw) throw r.throw;
    const status = r.status ?? 200;
    if (status >= 400) {
      return new Response(null, { status, statusText: "ERR" });
    }
    return new Response(r.body ?? new Uint8Array([1, 2, 3]), {
      status,
      headers: { "content-length": String(r.body?.length ?? 3) },
    });
  };
}

const TINY = new Uint8Array(1024).map((_, i) => i % 251);
const TINY_HASH = sha256Of(TINY);

const fakeModel = (overrides: Partial<RegisteredModel> = {}): RegisteredModel => ({
  alias: "fake",
  description: "fake model",
  sources: [
    { kind: "huggingface", url: "https://hf.example/q.gguf" },
    { kind: "hf-mirror", url: "https://hfmirror.example/q.gguf" },
    { kind: "modelscope", url: "https://ms.example/api?FilePath=q.gguf" },
  ],
  sha256: TINY_HASH,
  sizeBytes: TINY.length,
  license: "Apache-2.0",
  minFreeMemGB: 1,
  contextWindow: 4096,
  recommended: false,
  ...overrides,
});

describe("defaultCacheDir / effectiveMirror", () => {
  it("uses AGENTKIT_MODEL_DIR when set", () => {
    process.env.AGENTKIT_MODEL_DIR = "/tmp/my-models";
    expect(defaultCacheDir()).toBe("/tmp/my-models");
  });

  it("falls back to ~/.agentkit/models", () => {
    delete process.env.AGENTKIT_MODEL_DIR;
    expect(defaultCacheDir()).toMatch(/\.agentkit[\\/]+models$/);
  });

  it("effectiveMirror prefers explicit arg, then env, then undefined", () => {
    process.env.AGENTKIT_MODEL_MIRROR = "modelscope";
    expect(effectiveMirror("hf-mirror")).toBe("hf-mirror");
    expect(effectiveMirror()).toBe("modelscope");
    delete process.env.AGENTKIT_MODEL_MIRROR;
    expect(effectiveMirror()).toBeUndefined();
  });
});

describe("filenameForSource", () => {
  it("extracts last path segment for direct URLs", () => {
    expect(filenameForSource({ kind: "huggingface", url: "https://x.com/a/b/c.gguf" })).toBe(
      "c.gguf"
    );
  });

  it("uses ModelScope's FilePath query param", () => {
    expect(
      filenameForSource({ kind: "modelscope", url: "https://ms/api?FilePath=qwen.gguf" })
    ).toBe("qwen.gguf");
  });

  it("sanitises unsafe characters", () => {
    // URL percent-encodes the space, so we expect %20 to land in the filename
    // and then get sanitised to underscores.
    expect(filenameForSource({ kind: "url", url: "https://x.com/weird name!.gguf" })).toBe(
      "weird_20name_.gguf"
    );
  });
});

describe("downloadGGUF", () => {
  it("downloads from the canonical source on a clean cache and verifies sha256", async () => {
    const m = fakeModel();
    const fetchImpl = makeFetchImpl({
      "https://hf.example/q.gguf": { body: TINY },
    });
    const result = await downloadGGUF(m, { cacheDir: dir, fetchImpl });
    expect(result.cacheHit).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.sourceUsed.kind).toBe("huggingface");
    expect(existsSync(result.path)).toBe(true);
  });

  it("falls through to the next mirror when the first errors", async () => {
    const m = fakeModel();
    const fetchImpl = makeFetchImpl({
      "https://hf.example/q.gguf": { throw: new Error("ECONNRESET") },
      "https://hfmirror.example/q.gguf": { body: TINY },
    });
    const result = await downloadGGUF(m, { cacheDir: dir, fetchImpl });
    expect(result.sourceUsed.kind).toBe("hf-mirror");
    expect(result.verified).toBe(true);
  });

  it("falls through HTTP 5xx as well as connection errors", async () => {
    const m = fakeModel();
    const fetchImpl = makeFetchImpl({
      "https://hf.example/q.gguf": { status: 503 },
      "https://hfmirror.example/q.gguf": { status: 502 },
      "https://ms.example/api?FilePath=q.gguf": { body: TINY },
    });
    const result = await downloadGGUF(m, { cacheDir: dir, fetchImpl });
    expect(result.sourceUsed.kind).toBe("modelscope");
  });

  it("throws LocalModelDownloadError when all sources fail", async () => {
    const m = fakeModel();
    const fetchImpl = makeFetchImpl({
      "https://hf.example/q.gguf": { status: 502 },
      "https://hfmirror.example/q.gguf": { throw: new Error("dns fail") },
      "https://ms.example/api?FilePath=q.gguf": { status: 500 },
    });
    await expect(downloadGGUF(m, { cacheDir: dir, fetchImpl })).rejects.toBeInstanceOf(
      LocalModelDownloadError
    );
  });

  it("rejects on sha256 mismatch and cleans up", async () => {
    const m = fakeModel({ sha256: "deadbeef".repeat(8) });
    const fetchImpl = makeFetchImpl({
      "https://hf.example/q.gguf": { body: TINY },
      "https://hfmirror.example/q.gguf": { body: TINY },
      "https://ms.example/api?FilePath=q.gguf": { body: TINY },
    });
    await expect(downloadGGUF(m, { cacheDir: dir, fetchImpl })).rejects.toBeInstanceOf(
      LocalModelDownloadError
    );
    // No file left behind on disk after all-fail.
    expect(existsSync(join(dir, "q.gguf"))).toBe(false);
  });

  it("cache hit on second call (verified again)", async () => {
    const m = fakeModel();
    let calls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      calls++;
      if (String(url) === "https://hf.example/q.gguf") {
        return new Response(TINY, {
          status: 200,
          headers: { "content-length": String(TINY.length) },
        });
      }
      throw new Error(`Unexpected ${url}`);
    };
    await downloadGGUF(m, { cacheDir: dir, fetchImpl });
    const second = await downloadGGUF(m, { cacheDir: dir, fetchImpl });
    expect(calls).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.verified).toBe(true);
  });

  it("respects mirror=hf-mirror by trying that source first", async () => {
    const m = fakeModel();
    const order: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      order.push(String(url));
      if (String(url) === "https://hfmirror.example/q.gguf") {
        return new Response(TINY, {
          status: 200,
          headers: { "content-length": String(TINY.length) },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const result = await downloadGGUF(m, { cacheDir: dir, fetchImpl, mirror: "hf-mirror" });
    expect(result.sourceUsed.kind).toBe("hf-mirror");
    expect(order[0]).toBe("https://hfmirror.example/q.gguf");
  });

  it("AGENTKIT_MODEL_MIRROR env var biases source order", async () => {
    process.env.AGENTKIT_MODEL_MIRROR = "modelscope";
    const m = fakeModel();
    const order: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      order.push(String(url));
      if (String(url) === "https://ms.example/api?FilePath=q.gguf") {
        return new Response(TINY, {
          status: 200,
          headers: { "content-length": String(TINY.length) },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const result = await downloadGGUF(m, { cacheDir: dir, fetchImpl });
    expect(result.sourceUsed.kind).toBe("modelscope");
    expect(order[0]).toBe("https://ms.example/api?FilePath=q.gguf");
  });

  it("warns-but-succeeds when sha256 is empty (registry not yet pinned)", async () => {
    const m = fakeModel({ sha256: "" });
    const fetchImpl = makeFetchImpl({
      "https://hf.example/q.gguf": { body: TINY },
    });
    const result = await downloadGGUF(m, { cacheDir: dir, fetchImpl });
    expect(result.verified).toBe(false);
    expect(result.cacheHit).toBe(false);
  });

  it("reports progress when callback is supplied", async () => {
    const m = fakeModel();
    const fetchImpl = makeFetchImpl({
      "https://hf.example/q.gguf": { body: TINY },
    });
    const events: Array<[number, number]> = [];
    await downloadGGUF(m, {
      cacheDir: dir,
      fetchImpl,
      onProgress: (t, total) => events.push([t, total]),
    });
    expect(events.length).toBeGreaterThan(0);
    const last = events.at(-1) as [number, number];
    expect(last[0]).toBe(TINY.length);
    expect(last[1]).toBe(TINY.length);
  });
});

describe("downloadUrl", () => {
  it("downloads without checksum when none supplied", async () => {
    const fetchImpl = makeFetchImpl({
      "https://x/y.gguf": { body: TINY },
    });
    const r = await downloadUrl("https://x/y.gguf", { cacheDir: dir, fetchImpl });
    expect(r.verified).toBe(false);
    expect(existsSync(r.path)).toBe(true);
  });

  it("verifies sha256 when supplied", async () => {
    const fetchImpl = makeFetchImpl({
      "https://x/y.gguf": { body: TINY },
    });
    const r = await downloadUrl("https://x/y.gguf", {
      cacheDir: dir,
      fetchImpl,
      expectedSha256: TINY_HASH,
    });
    expect(r.verified).toBe(true);
  });

  it("rejects on bad checksum and removes the file", async () => {
    const fetchImpl = makeFetchImpl({
      "https://x/y.gguf": { body: TINY },
    });
    await expect(
      downloadUrl("https://x/y.gguf", {
        cacheDir: dir,
        fetchImpl,
        expectedSha256: "0".repeat(64),
      })
    ).rejects.toBeInstanceOf(LocalModelChecksumError);
    expect(existsSync(join(dir, "y.gguf"))).toBe(false);
  });
});

describe("computeSha256", () => {
  it("matches Node's crypto for a known buffer", async () => {
    const file = join(dir, "buf.bin");
    await writeFile(file, TINY);
    const got = await computeSha256(file);
    expect(got).toBe(TINY_HASH);
    // Sanity: also matches a re-read.
    const echoed = sha256Of(new Uint8Array(await readFile(file)));
    expect(got).toBe(echoed);
  });
});
