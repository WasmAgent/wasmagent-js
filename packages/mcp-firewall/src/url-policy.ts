/**
 * URL target normalization + SSRF classification (P1-02).
 *
 * Regex-only host matching misses alternate IP encodings (decimal, octal,
 * hex), IPv6 forms, IPv4-mapped IPv6, and bare-host references. This module
 * parses a URL candidate, canonicalizes the host, and classifies it as
 * loopback / private / link-local / cloud-metadata.
 *
 * Boundary (documented, not hidden): the firewall is a PRE-flight layer. It
 * cannot see post-DNS-resolution addresses, so DNS rebinding is NOT
 * prevented here — deployments that need that guarantee must enforce the
 * resolved-IP policy in the runtime network layer.
 */

export type SsrfReason =
  | "loopback"
  | "unspecified"
  | "private_range"
  | "link_local"
  | "unique_local"
  | "cloud_metadata"
  | "localhost_name";

export interface UrlTargetClassification {
  /** True when the target must never receive autonomous agent traffic. */
  blocked: boolean;
  reason?: SsrfReason;
  /** Canonical host the classification was made on (diagnostics). */
  host?: string;
}

// ── Host parsing helpers ─────────────────────────────────────────────────────

/** Parse a canonical dotted-quad IPv4 string, or null when malformed. */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Decode non-dotted IPv4 representations accepted by many runtime URL
 * parsers: pure-integer (`2130706433`), and dotted forms with hex (`0x7f`),
 * octal (`0177`), or decimal-mixed segments. Returns 4 octets or null.
 */
function decodeAlternateIpv4(host: string): number[] | null {
  if (/^\d+$/.test(host)) {
    // 32-bit integer form.
    const n = Number.parseInt(host, 10);
    if (!Number.isSafeInteger(n) || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }

  // Hex/octal/decimal mixed dotted form — only when every segment is numeric-ish.
  const parts = host.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  if (!parts.every((p) => /^(0[xX][0-9a-fA-F]+|0[0-7]+|\d+)$/.test(p))) return null;

  const values = parts.map((p) => {
    if (/^0[xX]/.test(p)) return Number.parseInt(p, 16);
    if (/^0\d+$/.test(p)) return Number.parseInt(p, 8);
    return Number.parseInt(p, 10);
  });

  if (values.some((v) => !Number.isSafeInteger(v) || v > 255 || v < 0)) return null;

  if (values.length === 4) return values;
  // Short forms: a.b.c / a.b — last field covers the remaining octets.
  const octets = values.slice(0, -1);
  const last = values.at(-1);
  if (last === undefined) return null;
  let rest = last;
  while (octets.length < 4) {
    octets.unshift(rest & 0xff);
    rest >>>= 8;
  }
  return rest === 0 ? octets : null;
}

/** Parse an IPv6 address into 8 16-bit groups, or null when malformed. */
function parseIpv6(host: string): number[] | null {
  let h = host;
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1).
  const lastColon = h.lastIndexOf(":");
  if (h.includes(".")) {
    const tail = h.slice(lastColon + 1);
    const v4tail = parseIpv4(tail) ?? decodeAlternateIpv4(tail);
    if (v4tail === null) return null;
    const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = v4tail;
    h = `${h.slice(0, lastColon + 1)}${((o0 << 8) | o1).toString(16)}:${((o2 << 8) | o3).toString(16)}`;
  }

  const doubleColonCount = (h.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[] = [];
  let tail: string[] = [];
  if (doubleColonCount === 1) {
    const parts = h.split("::");
    const a = parts[0] ?? "";
    const b = parts[1] ?? "";
    head = a === "" ? [] : a.split(":");
    tail = b === "" ? [] : b.split(":");
  } else {
    head = h.split(":");
  }
  if (head.length + tail.length > 8) return null;

  const groups: number[] = [];
  for (const part of [...head, ...tail]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  const missing = 8 - groups.length;
  if (doubleColonCount === 1) {
    groups.splice(head.length, 0, ...new Array(missing).fill(0));
  } else if (missing !== 0) {
    return null;
  }
  return groups;
}

function ipv6PrefixMatches(groups: number[], prefixBits: number, prefix: number[]): boolean {
  const full = Math.floor(prefixBits / 16);
  for (let i = 0; i < full; i++) {
    if ((groups[i] ?? -1) !== (prefix[i] ?? -1)) return false;
  }
  const rem = prefixBits % 16;
  if (rem !== 0) {
    const shift = 16 - rem;
    const g = groups[full];
    const p = prefix[full];
    if (g !== undefined && p !== undefined && g >>> shift !== p >>> shift) return false;
  }
  return true;
}

/** Extract the embedded IPv4 from the last two IPv6 groups, when present. */
function embeddedIpv4(groups: number[]): number[] | undefined {
  const g6 = groups[6];
  const g7 = groups[7];
  if (g6 === undefined || g7 === undefined) return undefined;
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
}

// ── Host classification ──────────────────────────────────────────────────────

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "metadata",
]);

/**
 * Canonicalize and classify a raw host string (no scheme required).
 * Handles brackets, trailing dots, alternate IPv4 encodings, and IPv6.
 */
export function classifyHost(rawHost: string): UrlTargetClassification {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return { blocked: false };

  // Cloud metadata names first (they can resolve to non-link-local IPs).
  if (METADATA_HOSTS.has(host)) {
    return { blocked: true, reason: "cloud_metadata", host };
  }

  // Localhost names (any *.localhost / *.local.internal style).
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { blocked: true, reason: "localhost_name", host };
  }

  // IPv6.
  if (host.includes(":")) {
    const groups = parseIpv6(host);
    if (groups === null) return { blocked: false, host };
    if (groups.every((g) => g === 0)) return { blocked: true, reason: "unspecified", host };
    // IPv4-mapped IPv6 (::ffff:0:0/96) — classify the embedded IPv4.
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff
    ) {
      const v4 = embeddedIpv4(groups);
      if (v4) return classifyIpv4Octets(v4, host);
      return { blocked: false, host };
    }
    // NAT64 well-known prefix 64:ff9b::/96 — classify the embedded IPv4.
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
      const v4 = embeddedIpv4(groups);
      if (v4) return classifyIpv4Octets(v4, host);
      return { blocked: false, host };
    }
    if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) {
      return { blocked: true, reason: "loopback", host }; // ::1/128 exactly
    }
    if (ipv6PrefixMatches(groups, 10, [0xfe80])) {
      return { blocked: true, reason: "link_local", host }; // fe80::/10
    }
    if (ipv6PrefixMatches(groups, 7, [0xfc00])) {
      return { blocked: true, reason: "unique_local", host }; // fc00::/7
    }
    return { blocked: false, host };
  }

  // IPv4 — canonical dotted-quad or alternate encodings.
  const octets = parseIpv4(host) ?? decodeAlternateIpv4(host);
  if (octets !== null) return classifyIpv4Octets(octets, host);

  return { blocked: false, host };
}

function classifyIpv4Octets(octets: number[], host: string): UrlTargetClassification {
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  if (a === 127) return { blocked: true, reason: "loopback", host };
  if (a === 0) return { blocked: true, reason: "unspecified", host };
  if (a === 10) return { blocked: true, reason: "private_range", host };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: "private_range", host };
  if (a === 192 && b === 168) return { blocked: true, reason: "private_range", host };
  if (a === 169 && b === 254) {
    // Link-local includes the cloud metadata endpoint.
    const isMetadata = octets.join(".") === "169.254.169.254";
    return {
      blocked: true,
      reason: isMetadata ? "cloud_metadata" : "link_local",
      host,
    };
  }
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: "private_range", host };
  return { blocked: false, host };
}

// ── URL classification ───────────────────────────────────────────────────────

/**
 * Extract a URL/host candidate from an arbitrary string argument value and
 * classify it. Non-URL strings (prose, paths) classify as not-blocked —
 * argument values that are full URLs are the SSRF surface.
 */
export function classifyUrlTarget(raw: string): UrlTargetClassification {
  const text = raw.trim();
  if (text === "") return { blocked: false };

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  // Bare host[:port][/path] — no spaces; must look host-shaped: contains a
  // dot (name or IP), or a port, or a path. A single bare word ("tokyo",
  // "metadata") is prose, not a URL candidate.
  const bareMatch = /^([\w.-]+)(?::(\d{1,5}))?([/?#].*)?$/i.exec(text);
  const looksLikeHost =
    bareMatch !== null &&
    ((bareMatch[1] ?? "").includes(".") ||
      bareMatch[2] !== undefined ||
      bareMatch[3] !== undefined);
  if (!hasScheme && !looksLikeHost) return { blocked: false };

  let candidate = text;
  if (!hasScheme) candidate = `http://${candidate}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { blocked: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ftp:") {
    return { blocked: false };
  }

  return classifyHost(parsed.hostname);
}
