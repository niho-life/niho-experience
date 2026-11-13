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
  const ok = { accessToken: "web-access-1", expiresAt: "2026-10-21T04:00:00.000Z", refreshToken: "refresh-1", connectionId: "conn_1", connectionExpiresAt: "2027-01-19T03:00:00.000Z", user: { displayName: "合成 ホスト", iconImage: "https://images.example.test/a.jpg" } };

  it("posts the client id, code and verifier and reads the connection", async () => {
    const { deps: d, calls } = deps(() => json(200, ok));
    const result = await exchangeCode(d, { code: "code-1", codeVerifier: "verifier-1" });
    expect(result).toEqual({ ok: true, value: { accessToken: "web-access-1", accessTokenExpiresAt: Date.parse(ok.expiresAt), refreshToken: "refresh-1", connectionId: "conn_1", connectionExpiresAt: Date.parse(ok.connectionExpiresAt), displayName: "合成 ホスト", iconUrl: "https://images.example.test/a.jpg", authTimeUtc: null } });
    expect(calls[0]!.url).toBe(`${NIHO}/api/auth/app-connect/exchange`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ clientId: "niho-experience", code: "code-1", codeVerifier: "verifier-1" });
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("reads when the person signed in at NIHO (authTime) as a canonical UTC instant, and none for a missing or invalid one", async () => {
    const withTime = (authTime: unknown) => deps(() => json(200, { ...ok, authTime })).deps;
    const read = async (authTime: unknown) => {
      const result = await exchangeCode(withTime(authTime), { code: "c", codeVerifier: "v" });
      return result.ok ? result.value.authTimeUtc : "failed";
    };
    expect(await read("2026-10-21T03:10:00+00:00")).toBe("2026-10-21T03:10:00.000Z");
    expect(await read(Date.parse("2026-10-21T03:10:00.000Z"))).toBe("2026-10-21T03:10:00.000Z");
    for (const missing of [undefined, null, "", "yesterday", {}]) expect(await read(missing), String(missing)).toBeNull();
  });

  it("separates a refused code from an outage", async () => {
    expect(await exchangeCode(deps(() => json(400, { error: "invalid_code" })).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "rejected" });
    expect(await exchangeCode(deps(() => json(429, {})).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(deps(() => json(503, {})).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(deps(() => Promise.reject(new TypeError("network"))).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(deps(() => json(200, { customToken: "x", user: { id: "u1" } })).deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("connection refresh", () => {
  it("returns the rotated refresh token", async () => {
    const { deps: d, calls } = deps(() => json(200, { accessToken: "web-access-2", expiresAt: "2026-10-21T04:00:00.000Z", refreshToken: "refresh-2", connectionExpiresAt: "2027-01-19T03:00:00.000Z" }));
    const result = await refreshConnection(d, "refresh-1");
    expect(result).toMatchObject({ ok: true, value: { accessToken: "web-access-2", refreshToken: "refresh-2" } });
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

describe("the service ID token (niho-coliving/niho-app#20336)", () => {
  const TOKEN = "synthetic.service.id-token";
  const withToken = (serviceIdToken: NihoAuthDeps["serviceIdToken"], respond: Parameters<typeof deps>[0]) => {
    const made = deps(respond);
    return { ...made, deps: { ...made.deps, serviceIdToken } };
  };
  const ok = { accessToken: "web-access-1", expiresAt: "2026-10-21T04:00:00.000Z", refreshToken: "refresh-1", connectionId: "conn_1", connectionExpiresAt: "2027-01-19T03:00:00.000Z", user: { displayName: "合成 ホスト", iconImage: null } };

  it("goes in X-NIHO-Experience-Service-Id-Token on the exchange and on the connection's end, and nowhere else", async () => {
    const exchanged = withToken(async () => TOKEN, () => json(200, ok));
    await exchangeCode(exchanged.deps, { code: "c", codeVerifier: "v" });
    expect((exchanged.calls[0]!.init.headers as Record<string, string>)["x-niho-experience-service-id-token"]).toBe(TOKEN);
    // The token is never in the body or the URL.
    expect(String(exchanged.calls[0]!.init.body)).not.toContain(TOKEN);
    expect(exchanged.calls[0]!.url).not.toContain(TOKEN);

    const deleted = withToken(async () => TOKEN, () => new Response(null, { status: 204 }));
    await deleteConnection(deleted.deps, "conn_1", "id-1", { reason: null });
    expect(deleted.calls[0]!.init.headers).toEqual({ authorization: "Bearer id-1", "x-niho-experience-service-id-token": TOKEN });
    expect(deleted.calls[0]!.url).toBe(`${NIHO}/api/auth/app-connections/conn_1`);

    // The refresh is not counted by service (a log in never refreshes): it carries none.
    const refreshed = withToken(async () => TOKEN, () => json(200, { accessToken: "web-access-2", expiresAt: "2026-10-21T04:00:00.000Z", refreshToken: "refresh-2", connectionExpiresAt: "2027-01-19T03:00:00.000Z" }));
    await refreshConnection(refreshed.deps, "refresh-1");
    expect(JSON.stringify(refreshed.calls[0]!.init.headers)).not.toContain("service-id-token");
  });

  it("is left out, and the call still goes, when there is no token, it cannot be issued or the provider throws", async () => {
    for (const provider of [undefined, async () => null, async () => "", async () => { throw new Error("metadata server unavailable"); }] as const) {
      const exchanged = withToken(provider, () => json(200, ok));
      expect((await exchangeCode(exchanged.deps, { code: "c", codeVerifier: "v" })).ok).toBe(true);
      expect(JSON.stringify(exchanged.calls[0]!.init.headers)).not.toContain("service-id-token");
      const deleted = withToken(provider, () => new Response(null, { status: 204 }));
      expect(await deleteConnection(deleted.deps, "conn_1", "id-1", { reason: null })).toBe(true);
      expect(deleted.calls[0]!.init.headers).toEqual({ authorization: "Bearer id-1" });
    }
  });

  it("reads a 429 from the service's limit as try again later, not as a refused code", async () => {
    const limited = withToken(async () => TOKEN, () => json(429, { error: { code: "RATE_LIMITED", details: { reason: "experience_service_rate_limited" } } }));
    expect(await exchangeCode(limited.deps, { code: "c", codeVerifier: "v" })).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("logout", () => {
  it("deletes the connection with the Web access token and reason=logout", async () => {
    const { deps: d, calls } = deps(() => new Response(null, { status: 204 }));
    expect(await deleteConnection(d, "conn_1", "id-1")).toBe(true);
    expect(calls[0]!.url).toBe(`${NIHO}/api/auth/app-connections/conn_1?reason=logout`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.init.headers).toEqual({ authorization: "Bearer id-1" });
  });

  it("does not throw when NIHO is unreachable", async () => {
    expect(await deleteConnection(deps(() => Promise.reject(new TypeError("network"))).deps, "conn_1", "id-1")).toBe(false);
  });
});
