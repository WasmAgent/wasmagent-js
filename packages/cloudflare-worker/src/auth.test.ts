import { type JwtPayload, requireAuth, verifyJwt } from "./auth.js";

const SECRET = "test-secret-key-please-change";
const ISS = "https://auth.example.com";
const AUD = "wasmagent-api";

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

async function signHs256(payload: JwtPayload): Promise<string> {
  const header = base64UrlEncodeText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncodeText(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Future unix timestamp (token valid for 1 hour). */
function future(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

/** Standard valid payload with all mandatory claims. */
function validPayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: "user-1",
    iss: ISS,
    aud: AUD,
    exp: future(),
    scopes: ["agent:run"],
    ...overrides,
  };
}

describe("verifyJwt (HS256)", () => {
  it("accepts a valid token with all required claims", async () => {
    const token = await signHs256(validPayload());
    const payload = await verifyJwt(token, { kind: "hs256", secret: SECRET }, {
      requiredIss: ISS,
      requiredAud: AUD,
    });
    expect(payload.sub).toBe("user-1");
    expect(payload.scopes).toEqual(["agent:run"]);
  });

  it("rejects a token with wrong signature", async () => {
    const token = await signHs256(validPayload());
    await expect(
      verifyJwt(token, { kind: "hs256", secret: "wrong-secret" }, { requiredIss: ISS, requiredAud: AUD })
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signHs256(validPayload({ exp: past }));
    await expect(
      verifyJwt(token, { kind: "hs256", secret: SECRET }, { requiredIss: ISS, requiredAud: AUD })
    ).rejects.toThrow(/expired/);
  });

  it("rejects a malformed token", async () => {
    await expect(
      verifyJwt("not.a.token", { kind: "hs256", secret: SECRET })
    ).rejects.toThrow();
    await expect(
      verifyJwt("oneonly", { kind: "hs256", secret: SECRET })
    ).rejects.toThrow();
  });

  // ── New: mandatory exp ────────────────────────────────────────────────────

  it("rejects a token without exp claim", async () => {
    const { exp: _omit, ...noExp } = validPayload();
    const token = await signHs256(noExp as JwtPayload);
    await expect(
      verifyJwt(token, { kind: "hs256", secret: SECRET }, { requiredIss: ISS, requiredAud: AUD })
    ).rejects.toThrow(/missing exp/);
  });

  // ── New: iss validation ───────────────────────────────────────────────────

  it("rejects a token with wrong iss", async () => {
    const token = await signHs256(validPayload({ iss: "https://evil.example.com" }));
    await expect(
      verifyJwt(token, { kind: "hs256", secret: SECRET }, { requiredIss: ISS, requiredAud: AUD })
    ).rejects.toThrow(/iss mismatch/);
  });

  it("rejects a token missing iss when requiredIss is set", async () => {
    const { iss: _omit, ...noIss } = validPayload();
    const token = await signHs256(noIss as JwtPayload);
    await expect(
      verifyJwt(token, { kind: "hs256", secret: SECRET }, { requiredIss: ISS, requiredAud: AUD })
    ).rejects.toThrow(/missing iss/);
  });

  // ── New: aud validation ───────────────────────────────────────────────────

  it("rejects a token with wrong aud", async () => {
    const token = await signHs256(validPayload({ aud: "some-other-service" }));
    await expect(
      verifyJwt(token, { kind: "hs256", secret: SECRET }, { requiredIss: ISS, requiredAud: AUD })
    ).rejects.toThrow(/aud mismatch/);
  });

  it("rejects a token missing aud when requiredAud is set", async () => {
    const { aud: _omit, ...noAud } = validPayload();
    const token = await signHs256(noAud as JwtPayload);
    await expect(
      verifyJwt(token, { kind: "hs256", secret: SECRET }, { requiredIss: ISS, requiredAud: AUD })
    ).rejects.toThrow(/missing aud/);
  });

  it("accepts a token when aud is an array containing the required audience", async () => {
    const token = await signHs256(validPayload({ aud: ["wasmagent-api", "other-service"] }));
    const payload = await verifyJwt(token, { kind: "hs256", secret: SECRET }, {
      requiredIss: ISS,
      requiredAud: AUD,
    });
    expect(payload.sub).toBe("user-1");
  });

  // ── New: jti revocation ───────────────────────────────────────────────────

  it("rejects a token whose jti is in the revocation list", async () => {
    const token = await signHs256(validPayload({ jti: "token-abc-123" }));
    const revokedJti = new Set(["token-abc-123"]);
    await expect(
      verifyJwt(token, { kind: "hs256", secret: SECRET }, {
        requiredIss: ISS,
        requiredAud: AUD,
        revokedJti,
      })
    ).rejects.toThrow(/revoked/);
  });

  it("accepts a valid token whose jti is NOT in the revocation list", async () => {
    const token = await signHs256(validPayload({ jti: "token-good-456" }));
    const revokedJti = new Set(["token-abc-123"]);
    const payload = await verifyJwt(token, { kind: "hs256", secret: SECRET }, {
      requiredIss: ISS,
      requiredAud: AUD,
      revokedJti,
    });
    expect(payload.sub).toBe("user-1");
  });

  // ── New: fully compliant token (all claims present and correct) ───────────

  it("accepts a fully compliant token with iss, aud, exp, jti", async () => {
    const token = await signHs256(validPayload({ jti: "unique-token-id-789" }));
    const revokedJti = new Set(["other-revoked-id"]);
    const payload = await verifyJwt(token, { kind: "hs256", secret: SECRET }, {
      requiredIss: ISS,
      requiredAud: AUD,
      revokedJti,
    });
    expect(payload.sub).toBe("user-1");
    expect(payload.iss).toBe(ISS);
    expect(payload.aud).toBe(AUD);
    expect(payload.jti).toBe("unique-token-id-789");
  });

  it("does not check iss/aud when opts not provided", async () => {
    // Tokens without iss/aud still need exp
    const token = await signHs256({ sub: "user-1", exp: future() });
    const payload = await verifyJwt(token, { kind: "hs256", secret: SECRET });
    expect(payload.sub).toBe("user-1");
  });
});

describe("requireAuth", () => {
  it("rejects requests without Authorization header", async () => {
    const req = { headers: { get: () => null } };
    await expect(
      requireAuth(req, {
        key: { kind: "hs256", secret: SECRET },
        requiredIss: ISS,
        requiredAud: AUD,
      })
    ).rejects.toThrow(/missing Bearer/);
  });

  it("rejects when scope is missing", async () => {
    const token = await signHs256(validPayload({ scopes: ["agent:read"] }));
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    await expect(
      requireAuth(req, {
        key: { kind: "hs256", secret: SECRET },
        scope: "agent:run",
        requiredIss: ISS,
        requiredAud: AUD,
      })
    ).rejects.toThrow(/missing scope/);
  });

  it("returns AuthContext for a valid token", async () => {
    const token = await signHs256(
      validPayload({ sub: "u-42", scopes: ["agent:run"], rateLimit: { rpm: 30 } })
    );
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    const ctx = await requireAuth(req, {
      key: { kind: "hs256", secret: SECRET },
      scope: "agent:run",
      requiredIss: ISS,
      requiredAud: AUD,
    });
    expect(ctx.userId).toBe("u-42");
    expect(ctx.scopes).toEqual(["agent:run"]);
    expect(ctx.rateLimit?.rpm).toBe(30);
  });

  // ── New: config error when requiredIss or requiredAud is missing ──────────

  it("throws a config error when requiredIss is not provided", async () => {
    const req = { headers: { get: () => null } };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing misconfiguration
      requireAuth(req, { key: { kind: "hs256", secret: SECRET }, requiredAud: AUD } as any)
    ).rejects.toThrow(/configuration error.*requiredIss/i);
  });

  it("throws a config error when requiredAud is not provided", async () => {
    const req = { headers: { get: () => null } };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing misconfiguration
      requireAuth(req, { key: { kind: "hs256", secret: SECRET }, requiredIss: ISS } as any)
    ).rejects.toThrow(/configuration error.*requiredAud/i);
  });

  // ── New: iss / aud / jti propagated through requireAuth ──────────────────

  it("rejects a token with wrong iss via requireAuth", async () => {
    const token = await signHs256(validPayload({ iss: "https://evil.example.com" }));
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    await expect(
      requireAuth(req, {
        key: { kind: "hs256", secret: SECRET },
        requiredIss: ISS,
        requiredAud: AUD,
      })
    ).rejects.toThrow(/iss mismatch/);
  });

  it("rejects a token with wrong aud via requireAuth", async () => {
    const token = await signHs256(validPayload({ aud: "wrong-audience" }));
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    await expect(
      requireAuth(req, {
        key: { kind: "hs256", secret: SECRET },
        requiredIss: ISS,
        requiredAud: AUD,
      })
    ).rejects.toThrow(/aud mismatch/);
  });

  it("rejects a revoked jti via requireAuth", async () => {
    const token = await signHs256(validPayload({ jti: "revoked-jti-abc" }));
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    await expect(
      requireAuth(req, {
        key: { kind: "hs256", secret: SECRET },
        requiredIss: ISS,
        requiredAud: AUD,
        revokedJti: new Set(["revoked-jti-abc"]),
      })
    ).rejects.toThrow(/revoked/);
  });

  it("rejects a token missing exp via requireAuth", async () => {
    const { exp: _omit, ...noExp } = validPayload();
    const token = await signHs256(noExp as JwtPayload);
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    await expect(
      requireAuth(req, {
        key: { kind: "hs256", secret: SECRET },
        requiredIss: ISS,
        requiredAud: AUD,
      })
    ).rejects.toThrow(/missing exp/);
  });
});
