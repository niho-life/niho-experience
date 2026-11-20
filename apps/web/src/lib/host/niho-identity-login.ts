import "server-only";
import { createPublicKey, verify } from "node:crypto";
import contract from "@niho-experience/api-client/niho-login-contract";
import type { NihoAuthDeps, NihoConnectAudience, NihoConnectMethod } from "./niho-auth";
import { loginStatesMatch } from "./pkce";

const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const jwtPartPattern = /^[A-Za-z0-9_-]+$/;
const keyIdPattern = /^[A-Za-z0-9._-]{1,128}$/;
const subjectPattern = /^[!-~]{1,128}$/;
const maxClockSkewSeconds = 10;

interface IdentityLoginInput {
  nonce: string;
  redirectUri: string;
  maxAgeSeconds?: number;
}

export function nihoIdentityAuthorizationUrl(
  nihoOrigin: string,
  params: IdentityLoginInput & { challenge: string; state: string; audience: NihoConnectAudience; method?: NihoConnectMethod },
): string {
  const url = new URL(contract.authorizationPath, nihoOrigin);
  url.search = new URLSearchParams({
    client_id: contract.clientId,
    redirect_uri: params.redirectUri,
    response_type: contract.responseType,
    scope: contract.scope,
    code_challenge: params.challenge,
    code_challenge_method: contract.codeChallengeMethod,
    state: params.state,
    nonce: params.nonce,
    audience: params.audience,
    ...(params.method ? { method: params.method } : {}),
    ...(params.maxAgeSeconds === undefined ? {} : { max_age: String(params.maxAgeSeconds) }),
  }).toString();
  return url.href;
}

export function nihoIdentityRedirectUri(siteOrigin: string): string {
  return new URL(contract.redirectPath, siteOrigin).href;
}

type JsonRecord = Record<string, unknown>;
const objectOrNull = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

function decodeJwtPart(part: string): JsonRecord | null {
  const buffer = Buffer.from(part, "base64url");
  if (buffer.toString("base64url") !== part) return null;
  return objectOrNull(JSON.parse(buffer.toString("utf8")));
}

function epochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 253_402_300_800;
}

export function verifyNihoIdentityToken(params: {
  token: string; jwks: unknown; issuer: string; nonce: string; nowMs: number; maxAgeSeconds?: number;
}): { nihoUserId: string; authTimeMs: number } | null {
  if (params.token.length > 8192 || !secretPattern.test(params.nonce)) return null;
  const [encodedHeader, encodedPayload, signature, extra] = params.token.split(".");
  if (extra !== undefined || !encodedHeader || !encodedPayload || !signature
    || ![encodedHeader, encodedPayload, signature].every((part) => jwtPartPattern.test(part))) return null;

  try {
    const header = decodeJwtPart(encodedHeader);
    if (!header || header.alg !== contract.idTokenAlgorithm || header.typ !== "JWT"
      || typeof header.kid !== "string" || !keyIdPattern.test(header.kid) || Object.keys(header).length !== 3) return null;
    const keys = objectOrNull(params.jwks)?.keys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) return null;
    const matches = keys.map(objectOrNull).filter((key) => key?.kid === header.kid);
    if (matches.length !== 1) return null;
    const jwk = matches[0];
    if (!jwk || jwk.kty !== "RSA" || jwk.alg !== contract.idTokenAlgorithm || jwk.use !== "sig"
      || typeof jwk.n !== "string" || !jwtPartPattern.test(jwk.n)
      || typeof jwk.e !== "string" || !jwtPartPattern.test(jwk.e)) return null;
    const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      || !verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), key, Buffer.from(signature, "base64url"))) return null;

    const claims = decodeJwtPart(encodedPayload);
    if (!claims || claims.iss !== params.issuer || claims.aud !== contract.clientId
      || typeof claims.sub !== "string" || !subjectPattern.test(claims.sub)
      || typeof claims.nonce !== "string" || !secretPattern.test(claims.nonce)
      || !loginStatesMatch(params.nonce, claims.nonce)) return null;
    const { auth_time: authTime, iat, exp } = claims;
    const now = Math.floor(params.nowMs / 1000);
    if (!epochSeconds(authTime) || !epochSeconds(iat) || !epochSeconds(exp)
      || authTime > iat || iat > now + maxClockSkewSeconds || exp <= now || exp <= iat
      || exp - iat > contract.idTokenTtlSeconds
      || (params.maxAgeSeconds !== undefined && now - authTime > params.maxAgeSeconds)) return null;
    return { nihoUserId: claims.sub, authTimeMs: authTime * 1000 };
  } catch {
    return null;
  }
}

type IdentityExchangeResult =
  | { ok: true; value: { nihoUserId: string; authTimeMs: number } }
  | { ok: false; reason: "rejected" | "unavailable" | "unverified" };

export async function exchangeNihoIdentity(
  deps: NihoAuthDeps,
  params: IdentityLoginInput & { code: string; verifier: string },
): Promise<IdentityExchangeResult> {
  if (!secretPattern.test(params.code) || !secretPattern.test(params.verifier)) return { ok: false, reason: "rejected" };
  try {
    const origin = new URL(deps.nihoOrigin).origin;
    if (!origin.startsWith("https://")) return { ok: false, reason: "unavailable" };
    const serviceToken = await deps.nihoLoginServiceIdToken?.();
    if (!serviceToken) return { ok: false, reason: "unavailable" };
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 10_000);
    const response = await deps.fetch(new URL(contract.tokenPath, origin), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        [contract.serviceIdentityHeader]: serviceToken,
      },
      body: new URLSearchParams({
        grant_type: contract.grantType,
        client_id: contract.clientId,
        redirect_uri: params.redirectUri,
        code: params.code,
        code_verifier: params.verifier,
      }),
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!response.ok) return { ok: false, reason: response.status === 400 ? "rejected" : "unavailable" };
    const exchanged = objectOrNull(await response.json());
    if (!exchanged || typeof exchanged.id_token !== "string" || Object.keys(exchanged).length !== 1) {
      return { ok: false, reason: "unverified" };
    }
    const jwks = await deps.fetch(new URL(contract.jwksPath, origin), {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!jwks.ok) return { ok: false, reason: "unavailable" };
    const identity = verifyNihoIdentityToken({
      token: exchanged.id_token,
      jwks: await jwks.json(),
      issuer: origin + contract.issuerPath,
      nowMs: Date.now(),
      nonce: params.nonce,
      maxAgeSeconds: params.maxAgeSeconds,
    });
    return identity ? { ok: true, value: identity } : { ok: false, reason: "unverified" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
