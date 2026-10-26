import { describe, expect, it, vi } from "vitest";
import { deleteConnection, exchangeCode, nihoConnectUrl, refreshConnection, signInWithCustomToken, type NihoAuthDeps } from "./niho-auth";

const NIHO = "https://niho.example.test";
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);

function deps(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call.url, call.init);
  });
  return { deps: { fetch: fetchMock as unknown as typeof fetch, nihoOrigin: NIHO, firebaseWebApiKey: "synthetic-web-key" } satisfies NihoAuthDeps, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("NIHO confirmation URL", () => {
  it("carries the version, challenge, state and this site's origin", () => {
    const url = new URL(nihoConnectUrl(NIHO, { challenge: "c".repeat(43), state: "s".repeat(43), origin: "https://experience.example.test" }));
    expect(url.origin + url.pathname).toBe(`${NIHO}/connect/niho-experience`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ v: "1", challenge: "c".repeat(43), state: "s".repeat(43), origin: "https://experience.example.test" });
  });
});

describe("code exchange", () => {
  const ok = { accessToken: "api-only-1", expiresAt: "2026-10-21T04:00:00.000Z", refreshToken: "refresh-1", connectionId: "conn_1", connectionExpiresAt: "2027-01-19T03:00:00.000Z", user: { displayName: "合成 ホスト", iconImage: "https://images.example.test/a.jpg" } };

  it("posts the client id, code and verifier and reads the connection", async () => {
    const { deps: d, calls } = deps(() => json(200, ok));
    const result = await exchangeCode(d, { code: "code-1", codeVerifier: "verifier-1" });
    expect(result).toEqual({ ok: true, value: { accessToken: "api-only-1", accessTokenExpiresAt: Date.parse(ok.expiresAt), refreshToken: "refresh-1", connectionId: "conn_1", connectionExpiresAt: Date.parse(ok.connectionExpiresAt), displayName: "合成 ホスト", iconUrl: "https://images.example.test/a.jpg" } });
    expect(calls[0]!.url).toBe(`${NIHO}/api/auth/app-connect/exchange`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ clientId: "niho-experience", code: "code-1", codeVerifier: "verifier-1" });
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("separates a refused code from an outage", async () => {
    expect(await exchangeCode(deps(() => json(400, { error: "invalid_code" })).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "rejected" });
    expect(await exchangeCode(deps(() => json(429, {})).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(deps(() => json(503, {})).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(deps(() => Promise.reject(new TypeError("network"))).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(deps(() => json(200, { ...ok, accessToken: undefined, customToken: "legacy-custom" })).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("connection refresh", () => {
  it("returns the rotated refresh token", async () => {
    const { deps: d, calls } = deps(() => json(200, { accessToken: "api-only-2", expiresAt: "2026-10-21T04:00:00.000Z", refreshToken: "refresh-2", connectionExpiresAt: "2027-01-19T03:00:00.000Z" }));
    const result = await refreshConnection(d, "refresh-1");
    expect(result).toMatchObject({ ok: true, value: { accessToken: "api-only-2", accessTokenExpiresAt: Date.parse("2026-10-21T04:00:00.000Z"), refreshToken: "refresh-2" } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ clientId: "niho-experience", refreshToken: "refresh-1" });
  });

  it("reports an ended connection as rejected", async () => {
    expect(await refreshConnection(deps(() => json(401, { error: "connection_revoked" })).deps, "old")).toEqual({ ok: false, reason: "rejected" });
  });
});

describe("Firebase custom token sign-in", () => {
  it("turns the custom token into an ID token and its expiry", async () => {
    const { deps: d, calls } = deps(() => json(200, { idToken: "id-1", expiresIn: "3600", refreshToken: "firebase-refresh" }));
    expect(await signInWithCustomToken(d, "custom", NOW)).toEqual({ ok: true, value: { idToken: "id-1", idTokenExpiresAt: NOW + 3600 * 1000 } });
    expect(calls[0]!.url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic-web-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ token: "custom", returnSecureToken: true });
  });
});

describe("logout", () => {
  it("deletes the connection with the API bearer and reason=logout", async () => {
    const { deps: d, calls } = deps(() => new Response(null, { status: 204 }));
    expect(await deleteConnection(d, "conn_1", "api-only-1")).toBe(true);
    expect(calls[0]!.url).toBe(`${NIHO}/api/auth/app-connections/conn_1?reason=logout`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.init.headers).toEqual({ authorization: "Bearer api-only-1" });
  });

  it("does not throw when NIHO is unreachable", async () => {
    expect(await deleteConnection(deps(() => Promise.reject(new TypeError("network"))).deps, "conn_1", "id-1")).toBe(false);
  });
});
