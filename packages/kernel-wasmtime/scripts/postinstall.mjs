#!/usr/bin/env node

/**
 * postinstall.mjs — Download the javy static binary for the current platform.
 *
 * Supported platforms:
 *   darwin-arm64  (macOS, Apple Silicon)
 *   darwin-x64    (macOS, x86-64)
 *   linux-x64     (Linux, x86-64)
 *   linux-arm64   (Linux, ARM64)
 *
 * The binary is placed at:
 *   packages/kernel-wasmtime/vendor/javy-<platform>
 *
 * The download is skipped when:
 *   - WASMAGENT_SKIP_POSTINSTALL=1 is set (useful in CI that provides its own javy)
 *   - The binary already exists and matches the expected version
 *   - The platform is not in the supported list (a warning is printed instead)
 *
 * Usage: automatically invoked via package.json "postinstall" script.
 *        Can also be run manually: `node scripts/postinstall.mjs`
 */

import { chmodSync, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

// ── Configuration ────────────────────────────────────────────────────────────

const JAVY_VERSION = "3.4.0";

/**
 * Release asset names on https://github.com/bytecodealliance/javy/releases
 * keyed by `${os.platform()}-${os.arch()}`.
 */
const PLATFORM_ASSET = {
  "darwin-arm64": `javy-aarch64-macos-${JAVY_VERSION}.gz`,
  "darwin-x64": `javy-x86_64-macos-${JAVY_VERSION}.gz`,
  "linux-x64": `javy-x86_64-linux-${JAVY_VERSION}.gz`,
  "linux-arm64": `javy-aarch64-linux-${JAVY_VERSION}.gz`,
};

const BASE_URL = `https://github.com/bytecodealliance/javy/releases/download/v${JAVY_VERSION}`;

// ── Resolve paths ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VENDOR_DIR = join(__dirname, "..", "vendor");

// ── Helpers ──────────────────────────────────────────────────────────────────

function platformKey() {
  const { platform, arch } = process;
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
  return `${os}-${cpu}`;
}

function binaryName(key) {
  return `javy-${key}`;
}

/**
 * Download a URL to a file path, following redirects, with optional gunzip.
 */
function download(url, destPath, gunzip = false) {
  return new Promise((resolve, reject) => {
    function attempt(currentUrl) {
      httpsGet(currentUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (!res.headers.location)
            return reject(new Error(`Redirect without Location: ${currentUrl}`));
          return attempt(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
        }
        const dest = createWriteStream(destPath);
        const src = gunzip ? res.pipe(createGunzip()) : res;
        pipeline(src, dest).then(resolve).catch(reject);
      }).on("error", reject);
    }
    attempt(url);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.env.WASMAGENT_SKIP_POSTINSTALL === "1") {
    console.log("[kernel-wasmtime] WASMAGENT_SKIP_POSTINSTALL=1 — skipping javy download.");
    return;
  }

  const key = platformKey();
  const asset = PLATFORM_ASSET[key];

  if (!asset) {
    console.warn(
      `[kernel-wasmtime] Unsupported platform "${key}" — javy binary not downloaded. ` +
        "Install javy manually: https://github.com/bytecodealliance/javy/releases"
    );
    return;
  }

  if (!existsSync(VENDOR_DIR)) {
    mkdirSync(VENDOR_DIR, { recursive: true });
  }

  const binPath = join(VENDOR_DIR, binaryName(key));
  const versionMarker = `${binPath}.version`;

  // Skip if already downloaded at the correct version.
  if (existsSync(binPath) && existsSync(versionMarker)) {
    const { readFileSync } = await import("node:fs");
    const savedVersion = readFileSync(versionMarker, "utf8").trim();
    if (savedVersion === JAVY_VERSION) {
      console.log(`[kernel-wasmtime] javy ${JAVY_VERSION} already present at ${binPath}`);
      return;
    }
  }

  const url = `${BASE_URL}/${asset}`;
  console.log(`[kernel-wasmtime] Downloading javy ${JAVY_VERSION} for ${key}…`);
  console.log(`  ${url}`);

  try {
    await download(url, binPath, /* gunzip= */ true);
    chmodSync(binPath, 0o755);

    // Write version marker.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(versionMarker, JAVY_VERSION, "utf8");

    const size = statSync(binPath).size;
    console.log(
      `[kernel-wasmtime] javy ${JAVY_VERSION} saved to ${binPath} (${(size / 1024 / 1024).toFixed(1)} MB)`
    );
  } catch (err) {
    // Non-fatal: the kernel still works if javy is installed system-wide via PATH.
    console.warn(
      `[kernel-wasmtime] Warning: failed to download javy binary — ${err.message}\n` +
        "  Install javy manually: https://github.com/bytecodealliance/javy/releases"
    );
  }
}

main().catch((err) => {
  console.error("[kernel-wasmtime] postinstall error:", err);
  // Exit 0 so that npm install does not fail if network is unavailable.
  process.exit(0);
});
