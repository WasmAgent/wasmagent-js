/**
 * Resource path normalization + sensitive-path classification (P1-01).
 *
 * The firewall is a pure preflight layer: it does NOT resolve symlinks or
 * stat the filesystem. Instead it normalizes lexical path representations
 * (home aliases, file URIs, dot segments, Windows separators, URL encoding)
 * and classifies the result against well-known credential stores. The
 * runtime sandbox remains responsible for enforcing canonical-path
 * boundaries after resolution — see the README security model.
 */

// ── Sensitive path classes ───────────────────────────────────────────────────

export type SensitivePathClass =
  | "ssh_keys"
  | "aws_credentials"
  | "gnupg_keyring"
  | "unix_accounts"
  | "gcloud_credentials"
  | "azure_credentials"
  | "kubeconfig"
  | "vcs_credentials";

/**
 * Segment-based sensitive path signatures. A path is sensitive when its
 * normalized segment sequence CONTAINS one of these consecutive runs —
 * the check is position-independent so `~/x/.ssh/id_rsa`,
 * `/home/u/.ssh/id_rsa`, and `C:\Users\u\.ssh\id_rsa` all classify.
 *
 * All signatures are lowercase; the normalized path is lowercased before
 * matching. Credential stores are matched by directory segment (.ssh, .aws,
 * …) rather than by file name so every key/file inside the store is covered.
 */
const SENSITIVE_SIGNATURES: Array<{ run: string[]; class: SensitivePathClass }> = [
  { run: [".ssh"], class: "ssh_keys" },
  { run: [".aws"], class: "aws_credentials" },
  { run: [".gnupg"], class: "gnupg_keyring" },
  { run: ["etc", "passwd"], class: "unix_accounts" },
  { run: ["etc", "shadow"], class: "unix_accounts" },
  { run: [".config", "gcloud"], class: "gcloud_credentials" },
  { run: [".azure"], class: "azure_credentials" },
  { run: [".kube"], class: "kubeconfig" },
  { run: [".git-credentials"], class: "vcs_credentials" },
  { run: [".netrc"], class: "vcs_credentials" },
];

/** Sentinel substituted for every home-directory alias before segmenting. */
const HOME_SENTINEL = "home";

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Decode a `file:` URI (or a bare `file:` reference) to a plain path.
 * `file:///home/u/.ssh/id_rsa` → `/home/u/.ssh/id_rsa`,
 * `file://home/u/x` → `/home/u/x` (host component treated as path when it
 * parses as one), percent-encoding is decoded.
 */
function decodeFileUri(raw: string): string | null {
  const m = /^file:\/{2,3}(?:[^/]+)?(\/.*)$/i.exec(raw.trim());
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return null;
}

/**
 * Lexically normalize a resource path reference.
 *
 * Handled representations (hostile and benign):
 * - home aliases: `~`, `~/x`, `${HOME}/x`, `$HOME/x`, `%USERPROFILE%\x`
 * - file URIs: `file:///home/u/.ssh/id_rsa`
 * - dot segments: `a/b/../c` → `a/c`, `.skipped/./segments`
 * - Windows separators: `\` → `/`, drive letters preserved
 * - percent-encoded segments (after file-URI extraction)
 *
 * The result is an absolute-looking POSIX-style path with a synthetic root;
 * it is a classification input, not a real filesystem path.
 */
export function normalizeResourcePath(raw: string): string {
  let p = raw.trim();

  // Percent-decoding must precede file-URI extraction so that encoded
  // references like `file://%2Fhome%2Fuser%2F.ssh%2Fid_rsa` are caught.
  if (/%[0-9a-fA-F]{2}/.test(p)) {
    try {
      p = decodeURIComponent(p);
    } catch {
      // Malformed percent-sequence — keep current state.
    }
  }

  const fileUri = decodeFileUri(p);
  if (fileUri !== null) p = fileUri;

  // Home aliases → sentinel (before splitting so `~/.ssh` and `${HOME}/.ssh`
  // produce identical segment sequences).
  p = p.replace(/^(?:~|\$\{HOME\}|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)/i, HOME_SENTINEL);

  p = p.replace(/\\/g, "/");

  // Split, drop "." and empty segments, resolve ".." lexically.
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Pop the previous segment unless it is a root-ish marker; anything
      // that escapes past the synthetic root is clamped — dot-segment
      // traversal must not be able to rename a path out of its class.
      if (out.length > 0 && out.at(-1) !== "..") out.pop();
      continue;
    }
    out.push(seg);
  }

  return `/${out.join("/")}`;
}

/**
 * Classify an (unnormalized) resource path reference.
 *
 * Returns the normalized path and, when the path points into a well-known
 * credential store, the sensitive class. `isSensitive` is true whenever
 * `sensitiveClass` is set — callers should treat the value as a secret
 * source regardless of the argument name carrying it.
 */
export function classifyResourcePath(raw: string): {
  normalized: string;
  sensitiveClass: SensitivePathClass | undefined;
  isSensitive: boolean;
} {
  const normalized = normalizeResourcePath(raw).toLowerCase();
  const segments = normalized.split("/");

  for (const { run, class: cls } of SENSITIVE_SIGNATURES) {
    for (let i = 0; i + run.length <= segments.length; i++) {
      let matched = true;
      for (let j = 0; j < run.length; j++) {
        if (segments[i + j] !== run[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { normalized, sensitiveClass: cls, isSensitive: true };
      }
    }
  }

  return { normalized, sensitiveClass: undefined, isSensitive: false };
}

/**
 * Extract every string value from an arbitrary argument tree (deep, bounded).
 *
 * Structural rules must inspect nested argument objects — an attacker
 * controls argument names and nesting, so a top-level `Object.values` scan
 * misses `wrapper: { path: "~/.ssh/id_rsa" }`. Depth and node caps keep the
 * traversal O(size of payload) and immune to cyclic structures.
 */
export function deepStringValues(
  value: unknown,
  opts?: { maxDepth?: number; maxNodes?: number }
): string[] {
  const maxDepth = opts?.maxDepth ?? 8;
  const maxNodes = opts?.maxNodes ?? 512;
  const out: string[] = [];
  const queue: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  let visited = 0;

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const { v, d } = next;
    visited++;
    if (visited > maxNodes) break;
    if (typeof v === "string") {
      out.push(v);
      continue;
    }
    if (d >= maxDepth) continue;
    if (Array.isArray(v)) {
      for (const item of v) queue.push({ v: item, d: d + 1 });
    } else if (v !== null && typeof v === "object") {
      for (const item of Object.values(v as Record<string, unknown>)) {
        queue.push({ v: item, d: d + 1 });
      }
    }
  }

  return out;
}
