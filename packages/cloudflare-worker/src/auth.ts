/**
 * JWT authentication for the WasmAgent Cloudflare Worker.
 *
 * Supports HS256 (shared secret) and RS256 (public/private keypair) via
 * the WebCrypto API — no extra dependencies. Verified payloads carry
 * `userId`, `scopes`, and an optional per-user rate-limit override.
 *
 * Tokens are passed in the standard `Authorization: Bearer <token>`
 * header. Unauthenticated routes can still be hit; per-route checks
 * happen in the request handler via {@link requireAuth}.
 */

export interface JwtPayload {
  /** Subject — typically the user id. */
  sub: string;
  /** Granted scopes, e.g. ["agent:run", "tools:write", "memory:read"]. */
  scopes?: string[];
  /** Optional per-user rate-limit override. */
  rateLimit?: { rpm?: number; tpm?: number };
  /** Expiration (Unix seconds). */
  exp?: number;
  /** Issued-at (Unix seconds). */
  iat?: number;
  /** Free-form extra claims. */
  [k: string]: unknown;
}

export interface AuthContext {
  userId: string;
  scopes: string[];
  rateLimit?: { rpm?: number; tpm?: number };
  raw: JwtPayload;
}

export type JwtVerifierKey =
  | { kind: "hs256"; secret: string }
  | { kind: "rs256"; publicKeyPem: string };

function base64UrlDecode(input: string): Uint8Array {
  // Convert from base64url to base64
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeText(input: string): string {
  return new TextDecoder().decode(base64UrlDecode(input));
}

async function importHs256Key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

async function importRs256Key(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/**
 * Verify a JWT and return the parsed payload. Throws on any failure
 * (invalid signature, expired, malformed, unsupported alg).
 */
export async function verifyJwt(token: string, key: JwtVerifierKey): Promise<JwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("verifyJwt: token must have 3 parts");
  const [h, p, sig] = parts as [string, string, string];

  const headerJson = base64UrlDecodeText(h);
  const header = JSON.parse(headerJson) as { alg?: string };
  if (key.kind === "hs256" && header.alg !== "HS256") {
    throw new Error(`verifyJwt: expected HS256, got ${header.alg}`);
  }
  if (key.kind === "rs256" && header.alg !== "RS256") {
    throw new Error(`verifyJwt: expected RS256, got ${header.alg}`);
  }

  const cryptoKey =
    key.kind === "hs256"
      ? await importHs256Key(key.secret)
      : await importRs256Key(key.publicKeyPem);

  const data = new TextEncoder().encode(`${h}.${p}`);
  const sigBuf = base64UrlDecode(sig);
  const algorithm = key.kind === "hs256" ? "HMAC" : "RSASSA-PKCS1-v1_5";
  const ok = await crypto.subtle.verify(algorithm, cryptoKey, sigBuf, data);
  if (!ok) throw new Error("verifyJwt: signature verification failed");

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecodeText(p)) as JwtPayload;
  } catch (e) {
    throw new Error(
      `verifyJwt: payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Validate required claims at runtime — the `as JwtPayload` cast above is
  // structurally unchecked; without this guard a token like `{"sub": null}`
  // produces userId=null downstream, silently merging unrelated callers in
  // KV / D1 keys.
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("verifyJwt: token is missing required 'sub' (subject) claim");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && payload.exp < nowSec) {
    throw new Error("verifyJwt: token expired");
  }
  // `nbf` (Not Before) — token not yet valid.
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) {
    throw new Error("verifyJwt: token not yet valid (nbf)");
  }
  return payload;
}

export interface RequireAuthOpts {
  /** Required scope; throws if not present. */
  scope?: string;
  /** Verifier key — usually built from env. */
  key: JwtVerifierKey;
}

/**
 * Extract the Bearer token from a Hono / Fetch Request, verify it, and
 * return the auth context. Throws on missing or invalid token.
 */
export async function requireAuth(
  request: { headers: { get(name: string): string | null } },
  opts: RequireAuthOpts
): Promise<AuthContext> {
  const auth = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new Error("requireAuth: missing Bearer token");
  }
  const token = auth.slice("Bearer ".length).trim();
  const payload = await verifyJwt(token, opts.key);

  const scopes = payload.scopes ?? [];
  if (opts.scope && !scopes.includes(opts.scope)) {
    throw new Error(`requireAuth: missing scope "${opts.scope}"`);
  }

  const ctx: AuthContext = {
    userId: payload.sub,
    scopes,
    raw: payload,
  };
  if (payload.rateLimit !== undefined) ctx.rateLimit = payload.rateLimit;
  return ctx;
}
