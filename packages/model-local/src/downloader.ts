/**
 * Multi-mirror downloader for GGUF model files.
 *
 * Resolution precedence (high → low):
 *   1. Explicit `mirror` argument (programmatic).
 *   2. `AGENTKIT_MODEL_MIRROR` env var — value is a {@link SourceKind}
 *      preset or a URL prefix to a custom CDN.
 *   3. Registry-declared order (HuggingFace first; mirrors as fallback).
 *
 * Reliability model:
 *   - Try each source in order; on connection error / timeout / non-2xx,
 *     move to the next source. Only after all sources fail do we throw.
 *   - sha256 verification is mandatory for {@link RegisteredModel} entries
 *     that have a non-empty `sha256`. Empty sha256 (still being pinned)
 *     produces a warning but proceeds — see registry.ts.
 *
 * Caching:
 *   - Default cache directory: `~/.agentkit/models`
 *   - Override: `AGENTKIT_MODEL_DIR` env var, or `cacheDir` arg.
 *   - Files are stored under `<cacheDir>/<sanitised-filename>`. We do NOT
 *     re-download if a cached file matches sha256 (or is present and the
 *     entry has no sha256 pinned).
 *
 * Atomicity:
 *   - Downloads stream to `<cacheDir>/<filename>.partial` and rename on
 *     completion, so an interrupted download never produces a half-good
 *     cache file. (node-llama-cpp's resolveModelFile does this too; we
 *     replicate it because users may opt into our path-based loading.)
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type ModelSource,
  type RegisteredModel,
  getRegisteredModel,
  orderSources,
} from "./registry.js";
import { LocalModelChecksumError, LocalModelDownloadError } from "./types.js";

export interface DownloadOptions {
  /** Override cache directory. Default: $AGENTKIT_MODEL_DIR or ~/.agentkit/models. */
  cacheDir?: string;
  /** Override mirror preference. Beats env var. */
  mirror?: string;
  /** Per-source connect timeout in ms. Default 15s. */
  timeoutMs?: number;
  /** Progress callback: (transferred, total). total === 0 if unknown. */
  onProgress?: (transferred: number, total: number) => void;
  /**
   * Custom fetch impl (mostly for tests). Defaults to global `fetch`.
   * Must return a Response with `.body` as a ReadableStream.
   */
  fetchImpl?: typeof fetch;
}

export function defaultCacheDir(): string {
  const env = process.env.AGENTKIT_MODEL_DIR;
  if (env && env.length > 0) return env;
  return join(homedir(), ".agentkit", "models");
}

export function effectiveMirror(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const env = process.env.AGENTKIT_MODEL_MIRROR;
  return env && env.length > 0 ? env : undefined;
}

/** Stable filename for a source URL (last path segment, sanitised). */
export function filenameForSource(source: ModelSource): string {
  // ModelScope-style URLs pass the filename in a `FilePath=` query param;
  // pull it out so the cache name stays predictable.
  try {
    const url = new URL(source.url);
    const fp = url.searchParams.get("FilePath");
    if (fp) return sanitise(fp.split("/").pop() ?? "model.gguf");
    const last = url.pathname.split("/").pop() ?? "";
    return sanitise(last || "model.gguf");
  } catch {
    return "model.gguf";
  }
}

function sanitise(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Compute sha256 of a file in chunks. Returns a lowercase hex digest.
 */
export async function computeSha256(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Resolve a {@link RegisteredModel} to a local file path, downloading from
 * the first reachable mirror if necessary. Verifies sha256 when pinned.
 *
 * @returns the absolute path to the cached GGUF file.
 */
export async function resolveModel(
  alias: string,
  opts: DownloadOptions = {}
): Promise<{ path: string; sourceUsed: ModelSource; cacheHit: boolean; verified: boolean }> {
  const model = getRegisteredModel(alias);
  return downloadGGUF(model, opts);
}

export async function downloadGGUF(
  model: RegisteredModel,
  opts: DownloadOptions = {}
): Promise<{ path: string; sourceUsed: ModelSource; cacheHit: boolean; verified: boolean }> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  await mkdir(cacheDir, { recursive: true });

  const sources = orderSources(model, effectiveMirror(opts.mirror));
  if (sources.length === 0) {
    throw new LocalModelDownloadError(`No download sources registered for "${model.alias}"`);
  }

  // Use the canonical (HF) source's filename for the cache so all mirrors land
  // on the same on-disk path and a follow-up call with a different mirror is a
  // cache hit.
  const canonicalFilename = filenameForSource(sources[0] as ModelSource);
  const finalPath = join(cacheDir, canonicalFilename);

  // Cache hit?
  if (existsSync(finalPath)) {
    if (model.sha256) {
      const got = await computeSha256(finalPath);
      if (got === model.sha256) {
        return {
          path: finalPath,
          sourceUsed: sources[0] as ModelSource,
          cacheHit: true,
          verified: true,
        };
      }
      // Cached file fails verification — drop and re-download.
      await unlink(finalPath).catch(() => {});
    } else {
      // No pinned sha256 — assume cached file is good but flag unverified.
      return {
        path: finalPath,
        sourceUsed: sources[0] as ModelSource,
        cacheHit: true,
        verified: false,
      };
    }
  }

  // Try each source until one succeeds.
  const errors: { source: ModelSource; error: unknown }[] = [];
  for (const source of sources) {
    try {
      await downloadOne(source, finalPath, opts);
      // Verify sha256 if pinned.
      if (model.sha256) {
        const got = await computeSha256(finalPath);
        if (got !== model.sha256) {
          await unlink(finalPath).catch(() => {});
          throw new LocalModelChecksumError(
            `sha256 mismatch from ${source.kind}: expected ${model.sha256}, got ${got}`
          );
        }
        return { path: finalPath, sourceUsed: source, cacheHit: false, verified: true };
      }
      return { path: finalPath, sourceUsed: source, cacheHit: false, verified: false };
    } catch (err) {
      errors.push({ source, error: err });
      // Checksum errors are fatal per-source (file already removed) but we still
      // try the next mirror — same file may be intact there.
    }
  }

  const summary = errors
    .map((e) => `  - ${e.source.kind} (${e.source.url}): ${(e.error as Error)?.message ?? e.error}`)
    .join("\n");
  throw new LocalModelDownloadError(
    `Failed to download "${model.alias}" from any mirror:\n${summary}`,
    errors
  );
}

/**
 * Download a URL directly without registry lookup. Useful for {@link LocalModelOptions.source.url}.
 * Verifies sha256 only if `expectedSha256` is supplied.
 */
export async function downloadUrl(
  url: string,
  opts: DownloadOptions & { expectedSha256?: string } = {}
): Promise<{ path: string; verified: boolean }> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  await mkdir(cacheDir, { recursive: true });

  const filename = filenameForSource({ kind: "url", url });
  const finalPath = join(cacheDir, filename);

  if (existsSync(finalPath)) {
    if (opts.expectedSha256) {
      const got = await computeSha256(finalPath);
      if (got === opts.expectedSha256) return { path: finalPath, verified: true };
      await unlink(finalPath).catch(() => {});
    } else {
      return { path: finalPath, verified: false };
    }
  }

  await downloadOne({ kind: "url", url }, finalPath, opts);
  if (opts.expectedSha256) {
    const got = await computeSha256(finalPath);
    if (got !== opts.expectedSha256) {
      await unlink(finalPath).catch(() => {});
      throw new LocalModelChecksumError(
        `sha256 mismatch: expected ${opts.expectedSha256}, got ${got}`
      );
    }
    return { path: finalPath, verified: true };
  }
  return { path: finalPath, verified: false };
}

async function downloadOne(
  source: ModelSource,
  finalPath: string,
  opts: DownloadOptions
): Promise<void> {
  const partial = `${finalPath}.partial`;
  await mkdir(dirname(partial), { recursive: true });
  if (existsSync(partial)) await unlink(partial).catch(() => {});

  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetchFn(source.url, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(to);
  }
  if (!response.ok) {
    throw new LocalModelDownloadError(
      `HTTP ${response.status} ${response.statusText} from ${source.url}`
    );
  }
  if (!response.body) {
    throw new LocalModelDownloadError(`Empty response body from ${source.url}`);
  }

  const total = Number(response.headers.get("content-length") ?? "0");
  let transferred = 0;
  const onProgress = opts.onProgress;

  // Pipe the web stream into a Node write stream, reporting progress.
  const nodeStream = Readable.fromWeb(
    // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type difference between WhatWG and Node — runtime-compatible.
    response.body as any
  );
  if (onProgress) {
    nodeStream.on("data", (chunk: Buffer) => {
      transferred += chunk.length;
      onProgress(transferred, total);
    });
  }
  await pipeline(nodeStream, createWriteStream(partial));

  // Sanity check: sometimes the stream finishes 0 bytes (server hiccup).
  const st = await stat(partial);
  if (st.size === 0) {
    await unlink(partial).catch(() => {});
    throw new LocalModelDownloadError(`Empty file from ${source.url} (0 bytes)`);
  }

  await rename(partial, finalPath);
}
