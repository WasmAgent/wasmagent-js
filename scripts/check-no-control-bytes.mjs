#!/usr/bin/env node
/**
 * check-no-control-bytes.mjs
 *
 * Scan packages/**\/*.{ts,tsx,js,mjs} for stray NUL (0x00) and other
 * disallowed C0 control bytes (excluding the legitimate tab \x09 / LF \x0a /
 * CR \x0d) inside source files.
 *
 * Why this exists: 2026-06-26, a NUL byte ended up inside a regex character
 * class in packages/mcp-firewall/src/vetting.ts. It survived git commit, was
 * tolerated by `bun test`, broke `awk`/`cat`/`grep` reporting, and only
 * surfaced when biome's noControlCharactersInRegex fired in CI. By then we
 * had already pushed three red commits chasing a different symptom.
 *
 * Run by:
 *   - the pre-push git hook (.githooks/pre-push)
 *   - CI (.github/workflows/ci.yml)
 *   - npm run check:all
 *
 * Exit code 0 = clean. Exit code 1 = at least one offending file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const TARGETS = ["packages", "scripts", "tests"];
const EXT_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE_DIR_REGEX = /\/(node_modules|dist|\.turbo|\.next|coverage|vendor)\//;

// Disallowed C0 control bytes: everything in 0x00–0x1F except \t (0x09),
// \n (0x0a), \r (0x0d). Also disallow 0x7F (DEL).
const BAD_BYTES = new Set(Array.from({ length: 0x20 }, (_, i) => i));
BAD_BYTES.delete(0x09);
BAD_BYTES.delete(0x0a);
BAD_BYTES.delete(0x0d);
BAD_BYTES.add(0x7f);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (IGNORE_DIR_REGEX.test(`${full}/`)) continue;
    if (ent.isDirectory()) {
      yield* walk(full);
    } else if (ent.isFile() && EXT_REGEX.test(ent.name)) {
      yield full;
    }
  }
}

function describeByte(b) {
  if (b === 0x00) return "NUL (\\x00)";
  if (b === 0x07) return "BEL (\\x07)";
  if (b === 0x08) return "BS (\\x08)";
  if (b === 0x0b) return "VT (\\x0b)";
  if (b === 0x0c) return "FF (\\x0c)";
  if (b === 0x1b) return "ESC (\\x1b)";
  if (b === 0x7f) return "DEL (\\x7f)";
  return `\\x${b.toString(16).padStart(2, "0")}`;
}

function lineColOf(buf, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (buf[i] === 0x0a) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

let errors = 0;
let scanned = 0;

for (const target of TARGETS) {
  for await (const file of walk(join(ROOT, target))) {
    scanned++;
    const data = await readFile(file);
    for (let i = 0; i < data.length; i++) {
      if (BAD_BYTES.has(data[i])) {
        const { line, col } = lineColOf(data, i);
        const rel = relative(ROOT, file);
        console.error(`${rel}:${line}:${col}  ${describeByte(data[i])} byte at offset ${i}`);
        errors++;
        break; // one report per file is enough
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n✗ ${errors} file(s) contain disallowed control bytes.`);
  console.error("  Use \\uXXXX or \\xXX escape sequences in regex literals.");
  process.exit(1);
}

console.log(`✓ No disallowed control bytes in ${scanned} source files.`);
