import { describe, expect, it } from "vitest";
import { type JwtPayload, requireAuth, verifyJwt } from "./auth.js";

const SECRET = "test-secret-key-please-change";

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

describe("verifyJwt (HS256)", () => {
  it("accepts a valid token", async () => {
    const token = await signHs256({ sub: "user-1", scopes: ["agent:run"] });
    const payload = await verifyJwt(token, { kind: "hs256", secret: SECRET });
    expect(payload.sub).toBe("user-1");
    expect(payload.scopes).toEqual(["agent:run"]);
  });

  it("rejects a token with wrong signature", async () => {
    const token = await signHs256({ sub: "user-1" });
    await expect(verifyJwt(token, { kind: "hs256", secret: "wrong-secret" })).rejects.toThrow(
      /signature verification failed/
    );
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signHs256({ sub: "user-1", exp: past });
    await expect(verifyJwt(token, { kind: "hs256", secret: SECRET })).rejects.toThrow(/expired/);
  });

  it("rejects a malformed token", async () => {
    await expect(verifyJwt("not.a.token", { kind: "hs256", secret: SECRET })).rejects.toThrow();
    await expect(verifyJwt("oneonly", { kind: "hs256", secret: SECRET })).rejects.toThrow();
  });
});

describe("requireAuth", () => {
  it("rejects requests without Authorization header", async () => {
    const req = { headers: { get: () => null } };
    await expect(requireAuth(req, { key: { kind: "hs256", secret: SECRET } })).rejects.toThrow(
      /missing Bearer/
    );
  });

  it("rejects when scope is missing", async () => {
    const token = await signHs256({ sub: "u", scopes: ["agent:read"] });
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    await expect(
      requireAuth(req, { key: { kind: "hs256", secret: SECRET }, scope: "agent:run" })
    ).rejects.toThrow(/missing scope/);
  });

  it("returns AuthContext for a valid token", async () => {
    const token = await signHs256({ sub: "u-42", scopes: ["agent:run"], rateLimit: { rpm: 30 } });
    const req = {
      headers: {
        get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    };
    const ctx = await requireAuth(req, {
      key: { kind: "hs256", secret: SECRET },
      scope: "agent:run",
    });
    expect(ctx.userId).toBe("u-42");
    expect(ctx.scopes).toEqual(["agent:run"]);
    expect(ctx.rateLimit?.rpm).toBe(30);
  });
});
