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
  /** Expiration (Unix seconds). Required — tokens without exp are rejected. */
  exp?: number;
  /** Issued-at (Unix seconds). */
  iat?: number;
  /** Issuer. */
  iss?: string;
  /** Audience (single string or array). */
  aud?: string | string[];
  /** JWT ID — used for revocation checks. */
  jti?: string;
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
 * Options for {@link verifyJwt}.
 */
export interface VerifyJwtOpts {
  /**
   * If set, the token's `iss` claim must equal this value.
   * Tokens missing `iss` are rejected.
   */
  requiredIss?: string;
  /**
   * If set, the token's `aud` claim must include this value.
   * Tokens missing `aud` are rejected.
   */
  requiredAud?: string;
  /**
   * Set of JWT IDs that have been revoked. If the token's `jti` is
   * present in this set, verification fails.
   */
  revokedJti?: Set<string>;
}

/**
 * Verify a JWT and return the parsed payload. Throws on any failure
 * (invalid signature, expired, malformed, unsupported alg, missing exp,
 * iss/aud mismatch, or revoked jti).
 */
export async function verifyJwt(
  token: string,
  key: JwtVerifierKey,
  opts: VerifyJwtOpts = {}
): Promise<JwtPayload> {
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

  // exp is mandatory — tokens without an expiration are rejected.
  if (payload.exp === undefined) {
    throw new Error("verifyJwt: missing exp claim — tokens must have an expiration");
  }
  if (payload.exp < nowSec) {
    throw new Error("verifyJwt: token expired");
  }

  // `nbf` (Not Before) — token not yet valid.
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) {
    throw new Error("verifyJwt: token not yet valid (nbf)");
  }

  // iss (Issuer) check.
  if (opts.requiredIss !== undefined) {
    if (payload.iss === undefined) {
      throw new Error("verifyJwt: missing iss claim");
    }
    if (payload.iss !== opts.requiredIss) {
      throw new Error(
        `verifyJwt: iss mismatch — expected "${opts.requiredIss}", got "${payload.iss}"`
      );
    }
  }

  // aud (Audience) check.
  if (opts.requiredAud !== undefined) {
    if (payload.aud === undefined) {
      throw new Error("verifyJwt: missing aud claim");
    }
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(opts.requiredAud)) {
      throw new Error(`verifyJwt: aud mismatch — "${opts.requiredAud}" not in token audience`);
    }
  }

  // jti revocation check.
  if (opts.revokedJti !== undefined && typeof payload.jti === "string") {
    if (opts.revokedJti.has(payload.jti)) {
      throw new Error(`verifyJwt: token has been revoked (jti="${payload.jti}")`);
    }
  }

  return payload;
}

export interface RequireAuthOpts {
  /** Required scope; throws if not present. */
  scope?: string;
  /** Verifier key — usually built from env. */
  key: JwtVerifierKey;
  /**
   * Required issuer. Mandatory — omitting this is a configuration error.
   * Tokens missing or mismatching `iss` are rejected.
   */
  requiredIss: string;
  /**
   * Required audience. Mandatory — omitting this is a configuration error.
   * Tokens missing or not including `aud` are rejected.
   */
  requiredAud: string;
  /**
   * Optional set of revoked JWT IDs. Tokens whose `jti` is in this set
   * are rejected.
   */
  revokedJti?: Set<string>;
}

/**
 * Extract the Bearer token from a Hono / Fetch Request, verify it, and
 * return the auth context. Throws on missing or invalid token.
 *
 * `opts.requiredIss` and `opts.requiredAud` are mandatory. Omitting either
 * is a configuration error that throws immediately, preventing silent
 * pass-through of tokens with unvalidated issuer or audience.
 */
export async function requireAuth(
  request: { headers: { get(name: string): string | null } },
  opts: RequireAuthOpts
): Promise<AuthContext> {
  // Config-time guard: caller must always specify iss and aud.
  if (!opts.requiredIss) {
    throw new Error(
      "requireAuth: configuration error — opts.requiredIss is required to prevent silent iss bypass"
    );
  }
  if (!opts.requiredAud) {
    throw new Error(
      "requireAuth: configuration error — opts.requiredAud is required to prevent silent aud bypass"
    );
  }

  const auth = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new Error("requireAuth: missing Bearer token");
  }
  const token = auth.slice("Bearer ".length).trim();
  // Build verifyJwt opts conditionally so we don't pass `undefined` for
  // optional fields when exactOptionalPropertyTypes is on.
  const verifyOpts: Parameters<typeof verifyJwt>[2] = {
    requiredIss: opts.requiredIss,
    requiredAud: opts.requiredAud,
  };
  if (opts.revokedJti !== undefined) {
    verifyOpts.revokedJti = opts.revokedJti;
  }
  const payload = await verifyJwt(token, opts.key, verifyOpts);

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
