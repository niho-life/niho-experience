import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateVapidKeys } from "@niho-experience/web-push";

/** The push subscriptions BFF (#177 P2) against a synthetic pool and push service. */
const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    hostConsoleEnabled: true,
    hostPushEnabled: true,
    hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef",
    siteUrl: "https://experience.example.test",
    nihoWebOrigin: "https://niho.example.test",
    hostPushVapidSubject: "mailto:host-push@example.test",
    hostPushVapidPublicKey: "",
    hostPushVapidPrivateKey: "",
  },
  cookie: undefined as string | undefined,
  pool: null as { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => state.pool }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name === "__Secure-niho_host_session" && state.cookie ? { name, value: state.cookie } : undefined) }) }));

import { cookieSealer } from "@/lib/host/cookie-seal";
import { encodeSession, startSession } from "@/lib/host/session";
import { DELETE, POST as save } from "./route";
import { POST as status } from "./status/route";
import { POST as sendTest } from "./test/route";

const SITE = state.config.siteUrl;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/synthetic-device";
// A real P-256 point, so the test notification can be encrypted (RFC 8291 §5's receiver key).
const KEYS = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/json" };

let userCounter = 0;
const queries: { sql: string; params: unknown[] }[] = [];
let rows: unknown[] = [];

function signIn(nihoUserId = `user-${++userCounter}`) {
  const now = Date.now();
  const session = startSession({ nihoUserId, refreshToken: "refresh-1", idToken: "id-1", idTokenExpiresAt: now + 3_600_000, connectionId: "conn_1", connectionExpiresAt: now + 86_400_000, displayName: "合成 ホスト", iconUrl: null }, now);
  state.cookie = encodeSession(cookieSealer(state.config.hostSessionSecret, "session"), session);
  return nihoUserId;
}

const request = (path: string, body: unknown, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`${SITE}/host/api/push-subscriptions${path}`, { method: init.method ?? "POST", headers: { ...sameOrigin, "user-agent": IPHONE, ...init.headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  queries.length = 0;
  rows = [];
  state.pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: rows.length || 1, rows }; } };
  Object.assign(state.config, { apiMode: "http", hostPushEnabled: true });
  const keys = generateVapidKeys();
  state.config.hostPushVapidPublicKey = keys.publicKey;
  state.config.hostPushVapidPrivateKey = keys.privateKey;
  signIn();
});
afterEach(() => vi.unstubAllGlobals());

describe("gate", () => {
  it("is a 404 while push is off", async () => {
    state.config.hostPushEnabled = false;
    for (const route of [save, DELETE, status, sendTest]) expect((await route(request("", { endpoint: ENDPOINT }))).status).toBe(404);
    expect(queries).toEqual([]);
  });

  it("refuses cross-site calls, signed-out visitors and bodies that are not small JSON objects", async () => {
    expect((await save(request("", { endpoint: ENDPOINT, keys: KEYS }, { headers: { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    state.cookie = undefined;
    expect((await save(request("", { endpoint: ENDPOINT, keys: KEYS }))).status).toBe(401);
    signIn();
    expect((await save(request("", "x".repeat(5000)))).status).toBe(413);
    expect((await save(request("", "{", { headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect((await save(request("", { endpoint: ENDPOINT }, { headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await save(request("", [ENDPOINT]))).status).toBe(400);
    expect(queries).toEqual([]);
  });

  it("accepts only the browsers' push services and well-formed keys, and never echoes the endpoint", async () => {
    const outside = await save(request("", { endpoint: "https://169.254.169.254/latest", keys: KEYS }));
    expect(outside.status).toBe(400);
    expect(await outside.text()).not.toContain("169.254");
    expect((await save(request("", { endpoint: ENDPOINT, keys: { ...KEYS, auth: "short" } }))).status).toBe(400);
    expect((await save(request("", { endpoint: ENDPOINT, keys: { p256dh: KEYS.p256dh.slice(1), auth: KEYS.auth } }))).status).toBe(400);
    expect((await DELETE(request("", { endpoint: "http://fcm.googleapis.com/x" }, { method: "DELETE" }))).status).toBe(400);
    expect(queries).toEqual([]);
  });

  it("answers 503 when the experience database is not configured", async () => {
    state.pool = null;
    expect((await save(request("", { endpoint: ENDPOINT, keys: KEYS }))).status).toBe(503);
    expect((await status(request("/status", { endpoint: ENDPOINT }))).status).toBe(503);
  });
});

describe("subscriptions (http mode)", () => {
  it("saves this device for the host and the session's connection, with a coarse device label and unpadded keys", async () => {
    const user = signIn();
    const response = await save(request("", { endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: KEYS.p256dh, auth: `${KEYS.auth}==` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(queries[0]?.sql).toMatch(/^INSERT INTO host_push_subscriptions/);
    expect(queries[0]?.params).toEqual([user, "conn_1", ENDPOINT, KEYS.p256dh, KEYS.auth, "iphone"]);
  });

  it("removes and reads only the host's own row", async () => {
    const user = signIn();
    expect(await (await DELETE(request("", { endpoint: ENDPOINT }, { method: "DELETE" }))).json()).toEqual({ ok: true });
    expect(queries[0]?.params).toEqual([user, ENDPOINT]);
    rows = [];
    state.pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 0, rows: [] }; } };
    expect(await (await status(request("/status", { endpoint: ENDPOINT }))).json()).toEqual({ subscribed: false });
    // The row, if the host has one here, moves to this session's connection.
    expect(queries.at(-1)?.sql).toMatch(/^UPDATE host_push_subscriptions SET connection_id = \$3/);
    expect(queries.at(-1)?.params).toEqual([user, ENDPOINT, "conn_1"]);
    rows = [{ id: "7", endpoint: ENDPOINT, ...KEYS }];
    state.pool = { query: async () => ({ rowCount: 1, rows }) };
    expect(await (await status(request("/status", { endpoint: ENDPOINT }))).json()).toEqual({ subscribed: true });
  });

  it("answers 503 without detail when the database fails", async () => {
    state.pool = { query: async () => { throw new Error(`db down at ${ENDPOINT}`); } };
    const response = await save(request("", { endpoint: ENDPOINT, keys: KEYS }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("fcm");
  });
});

describe("テスト通知 (http mode)", () => {
  it("sends one encrypted message to the host's own device, then waits 30 seconds", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => { sent.push({ url: String(url), init }); return new Response(null, { status: 201 }); }));
    rows = [{ id: "7", endpoint: ENDPOINT, ...KEYS }];
    const response = await sendTest(request("/test", { endpoint: ENDPOINT }));
    expect(await response.json()).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(ENDPOINT);
    expect(new Headers(sent[0]?.init.headers).get("content-encoding")).toBe("aes128gcm");
    expect(queries.map((query) => query.sql.split(/\s+/)[0])).toEqual(["SELECT", "UPDATE"]);

    const again = await sendTest(request("/test", { endpoint: ENDPOINT }));
    expect(again.status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing to a device that is not the host's, and forgets one the push service no longer knows", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 410 }));
    vi.stubGlobal("fetch", fetchMock);
    state.pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 0, rows: [] }; } };
    expect((await sendTest(request("/test", { endpoint: ENDPOINT }))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();

    signIn();
    rows = [{ id: "7", endpoint: ENDPOINT, ...KEYS }];
    state.pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1, rows }; } };
    queries.length = 0;
    expect((await sendTest(request("/test", { endpoint: ENDPOINT }))).status).toBe(410);
    expect(queries.map((query) => [query.sql.split(/\s+/)[0], query.params])).toEqual([["SELECT", [expect.any(String), ENDPOINT]], ["DELETE", ["7"]]]);
  });

  it("reports a failed push service without detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    rows = [{ id: "7", endpoint: ENDPOINT, ...KEYS }];
    const response = await sendTest(request("/test", { endpoint: ENDPOINT }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "push_failed" });
  });
});

describe("preview (mock mode)", () => {
  it("validates, then answers without storing or sending", async () => {
    state.config.apiMode = "mock";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await (await save(request("", { endpoint: ENDPOINT, keys: KEYS }))).json()).toEqual({ ok: true, preview: true });
    expect((await save(request("", { endpoint: "https://evil.example.test/x", keys: KEYS }))).status).toBe(400);
    expect(await (await status(request("/status", { endpoint: ENDPOINT }))).json()).toEqual({ subscribed: true, preview: true });
    expect(await (await DELETE(request("", { endpoint: ENDPOINT }, { method: "DELETE" }))).json()).toEqual({ ok: true, preview: true });
    expect(await (await sendTest(request("/test", { endpoint: ENDPOINT }))).json()).toEqual({ sent: false, preview: true });
    expect(queries).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
