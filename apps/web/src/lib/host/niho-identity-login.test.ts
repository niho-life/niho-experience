import { generateKeyPairSync, sign } from "node:crypto";
import contract from "@niho-experience/api-client/niho-login-contract";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { exchangeNihoIdentity, verifyNihoIdentityToken } from "./niho-identity-login";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "test-key";
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
const issuer = "https://niho.example.test" + contract.issuerPath;
const nonce = "a".repeat(43);
const now = 1_795_139_700;
const payload = {
  iss: issuer, aud: contract.clientId, sub: "niho-user",
  auth_time: now - 300, nonce, iat: now, exp: now + contract.idTokenTtlSeconds,
};
const header = { alg: "RS256", typ: "JWT", kid };

function token(claims: Record<string, unknown> = payload, joseHeader: Record<string, unknown> = header): string {
  const input = [joseHeader, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

const proof = { jwks: { keys: [jwk] }, issuer, nonce, nowMs: now * 1000 };

describe("NIHO Login ID token", () => {
  it("returns the stable subject and the original sign-in time after signature and claim verification", () => {
    expect(verifyNihoIdentityToken({ ...proof, token: token(), maxAgeSeconds: 300 }))
      .toEqual({ nihoUserId: payload.sub, authTimeMs: payload.auth_time * 1000 });
  });

  it.each([
    ["issuer swap", { iss: "https://other.example.test" }],
    ["audience swap", { aud: "niho-experience-admin" }],
    ["multiple audiences", { aud: [contract.clientId, "another"] }],
    ["empty subject", { sub: "" }],
    ["state substitution for nonce", { nonce: "b".repeat(43) }],
    ["missing auth_time", { auth_time: undefined }],
    ["auth_time newer than issuance", { auth_time: now + 1 }],
    ["stale step-up", { auth_time: now - 301 }],
    ["future issuance", { iat: now + 11 }],
    ["expired token", { iat: now - 90, exp: now }],
    ["extended expiry", { exp: now + contract.idTokenTtlSeconds + 1 }],
  ])("rejects %s even for a valid signature", (_name, changed) => {
    expect(verifyNihoIdentityToken({ ...proof, token: token({ ...payload, ...changed }), maxAgeSeconds: 300 })).toBeNull();
  });

  it("exchanges with the client-specific NIHO Login identity token, never the shared Host token", async () => {
    const sharedServiceIdToken = vi.fn(async () => "shared-host-token");
    const nihoLoginServiceIdToken = vi.fn(async () => "niho-login-client-token");
    const current = Math.floor(Date.now() / 1000);
    const claims = { ...payload, auth_time: current - 30, iat: current, exp: current + contract.idTokenTtlSeconds };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(contract.tokenPath)) {
        expect(new Headers(init?.headers).get(contract.serviceIdentityHeader)).toBe("niho-login-client-token");
        return new Response(JSON.stringify({ id_token: token(claims) }), { status: 200 });
      }
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }) as typeof fetch;

    const result = await exchangeNihoIdentity({
      fetch: fetchMock,
      nihoOrigin: "https://niho.example.test",
      serviceIdToken: sharedServiceIdToken,
      nihoLoginServiceIdToken,
    }, {
      code: "c".repeat(43),
      verifier: "v".repeat(43),
      nonce,
      redirectUri: "https://experience.example.test/host/auth/callback",
    });

    expect(result).toEqual({ ok: true, value: { nihoUserId: payload.sub, authTimeMs: (current - 30) * 1000 } });
    expect(nihoLoginServiceIdToken).toHaveBeenCalledOnce();
    expect(sharedServiceIdToken).not.toHaveBeenCalled();
  });

  it("fails closed when the dedicated NIHO Login identity token is unavailable", async () => {
    const sharedServiceIdToken = vi.fn(async () => "shared-host-token");
    const fetchMock = vi.fn() as typeof fetch;
    const result = await exchangeNihoIdentity({
      fetch: fetchMock,
      nihoOrigin: "https://niho.example.test",
      serviceIdToken: sharedServiceIdToken,
    }, {
      code: "c".repeat(43),
      verifier: "v".repeat(43),
      nonce,
      redirectUri: "https://experience.example.test/host/auth/callback",
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(sharedServiceIdToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown or duplicate key, an untrusted signature and unexpected JOSE fields", () => {
    for (const value of [
      { token: token(payload, { ...header, kid: "unknown" }) },
      { token: token(), jwks: { keys: [jwk, jwk] } },
      { token: token().replace(/[^.]+$/, "invalidSignature") },
      { token: token(payload, { ...header, jku: "https://other.example.test" }) },
      { token: token(payload, { ...header, alg: "none" }) },
    ]) expect(verifyNihoIdentityToken({ ...proof, ...value })).toBeNull();
  });
});
