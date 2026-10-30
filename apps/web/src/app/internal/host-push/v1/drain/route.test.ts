import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostNotificationOutbox, HostPushSubscriptions } from "@niho-experience/experience-store";

/** The host push job's trigger (#177 P2) with a synthetic Google identity, pool and drain. */
const mocks = vi.hoisted(() => ({
  config: {
    hostPushJobEnabled: true,
    hostPushJobAudience: "https://experience.example/internal/host-push",
    hostPushJobServiceAccountEmail: "host-push-job@example.iam.gserviceaccount.com",
  },
  verifyIdToken: vi.fn(),
  pool: vi.fn(),
  drain: vi.fn(),
  allowed: vi.fn(),
  hostPushDeps: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: mocks.pool, providerNotificationSettings: () => null }));
vi.mock("@/lib/host/push/outbox", () => ({ drainHostNotifications: mocks.drain, hostNotificationAllowed: mocks.allowed }));
vi.mock("@/lib/host/push/server", () => ({ hostPushDeps: mocks.hostPushDeps }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));

import type { GoogleTokenVerifier } from "@/lib/google-service-identity";
import { hostPushDrainResponse } from "@/lib/host/push/job";
import * as route from "./route";

const URL = "https://experience.example/internal/host-push/v1/drain";
const counts = { claimed: 2, delivered: 1, devicesSent: 3, skipped: 0, dropped: 1, retried: 0 };
const fakePool = { query: vi.fn() };
const post = (headers: Record<string, string> = { authorization: "Bearer synthetic.jwt.token" }) => route.POST(new Request(URL, { method: "POST", headers }));
const payload = (overrides: Record<string, unknown> = {}) => ({
  getPayload: () => ({
    iss: "https://accounts.google.com",
    aud: mocks.config.hostPushJobAudience,
    email: mocks.config.hostPushJobServiceAccountEmail,
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    sub: "service-synthetic",
    ...overrides,
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.hostPushJobEnabled = true;
  mocks.verifyIdToken.mockResolvedValue(payload());
  mocks.pool.mockReturnValue(fakePool);
  mocks.drain.mockResolvedValue(counts);
});

describe("POST /internal/host-push/v1/drain", () => {
  it("exports POST only, so every other method gets 405", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("is 404 before identity or database while the job is not configured", async () => {
    mocks.config.hostPushJobEnabled = false;
    const response = await post();
    expect(response.status).toBe(404);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it("accepts only the scheduler's Google service identity", async () => {
    for (const headers of [{}, { authorization: "Basic synthetic" }, { cookie: "__Secure-niho_host_session=synthetic" }] as Record<string, string>[]) {
      expect((await post(headers)).status).toBe(401);
    }
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    for (const claims of [
      { email: "other@example.iam.gserviceaccount.com" },
      { aud: "https://experience.example/internal/guide-admin" },
      { email_verified: false },
      { iss: "https://securetoken.google.com/project" },
      { exp: Math.floor(Date.now() / 1000) - 1 },
    ]) {
      mocks.verifyIdToken.mockResolvedValueOnce(payload(claims));
      const response = await post();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid_identity" });
    }
    mocks.verifyIdToken.mockRejectedValueOnce(new Error("Wrong number of segments in token"));
    expect((await post()).status).toBe(401);
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic.jwt.token", audience: mocks.config.hostPushJobAudience });
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it("is 503 when Google's keys cannot be fetched or the experience DB is not configured", async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } }));
    const outage = await post();
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ error: "identity_verification_unavailable" });
    mocks.pool.mockReturnValueOnce(null);
    const noPool = await post();
    expect(noPool.status).toBe(503);
    expect(await noPool.json()).toEqual({ error: "unavailable" });
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it("runs one drain on the experience DB and answers its counts, uncached", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.json()).toEqual(counts);
    expect(mocks.drain).toHaveBeenCalledOnce();
    const deps = mocks.drain.mock.calls[0]![0];
    expect(deps.outbox).toBeInstanceOf(HostNotificationOutbox);
    expect(deps.allowed).toBe(mocks.allowed);
    expect(typeof deps.now()).toBe("number");
    mocks.hostPushDeps.mockReturnValueOnce({ synthetic: true });
    expect(deps.pushDeps()).toEqual({ synthetic: true });
    expect(mocks.hostPushDeps.mock.calls[0]![0]).toBeInstanceOf(HostPushSubscriptions);
  });

  it("is 503 when the drain fails, and logs no database message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.drain.mockRejectedValueOnce(new Error("duplicate key value (provider-a, synthetic)"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/provider-a|synthetic/);
    error.mockRestore();
  });

  it("logs a run's counts only when it claimed something", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await post();
    const { log } = mocks.drain.mock.calls[0]![0];
    log({ ...counts, claimed: 0, delivered: 0, devicesSent: 0, dropped: 0 });
    expect(info).not.toHaveBeenCalled();
    log(counts);
    expect(info).toHaveBeenCalledExactlyOnceWith(`[host-push] drain ${JSON.stringify(counts)}`);
    info.mockRestore();
  });
});

describe("hostPushDrainResponse dependencies", () => {
  const settings = { enabled: true, audience: "https://experience.example/internal/host-push", serviceAccountEmail: "host-push-job@example.iam.gserviceaccount.com" };
  const verifier = (result: Awaited<ReturnType<GoogleTokenVerifier["verify"]>>): GoogleTokenVerifier => ({ verify: vi.fn().mockResolvedValue(result) });
  const request = new Request(URL, { method: "POST", headers: { authorization: "Bearer synthetic.jwt.token" } });
  const claims = { iss: "accounts.google.com", aud: settings.audience, email: settings.serviceAccountEmail, emailVerified: true, exp: Math.floor(Date.now() / 1000) + 60 };

  it("uses an injected verifier, pool and drain", async () => {
    const drain = vi.fn(async () => counts);
    const pool = vi.fn(() => fakePool as never);
    const ok = verifier({ ok: true, claims });
    const response = await hostPushDrainResponse(request, { settings, verifier: ok, pool, drain });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(counts);
    expect(ok.verify).toHaveBeenCalledWith("synthetic.jwt.token", settings.audience);
    expect(drain).toHaveBeenCalledWith(fakePool);
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it("separates an invalid identity from a verification outage", async () => {
    const drain = vi.fn(async () => counts);
    expect((await hostPushDrainResponse(request, { settings, verifier: verifier({ ok: false, kind: "invalid" }), drain })).status).toBe(401);
    expect((await hostPushDrainResponse(request, { settings, verifier: verifier({ ok: false, kind: "outage" }), drain })).status).toBe(503);
    expect((await hostPushDrainResponse(request, { settings: { ...settings, enabled: false }, verifier: verifier({ ok: true, claims }), drain })).status).toBe(404);
    expect(drain).not.toHaveBeenCalled();
  });
});
