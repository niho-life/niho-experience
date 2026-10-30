import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  settings: { audience: "https://experience.example/internal/ota/v1/watchdog", serviceAccountEmail: "watchdog@example.iam.gserviceaccount.com" } as
    { audience: string; serviceAccountEmail: string } | null,
  verifyIdToken: vi.fn(),
  runtime: null as { runWatchdog: ReturnType<typeof vi.fn>; authenticateWorker: ReturnType<typeof vi.fn> } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));
vi.mock("@/lib/experience/channel-runtime", async () => {
  const actual = await vi.importActual<typeof import("@/lib/experience/channel-runtime")>("@/lib/experience/channel-runtime");
  return { ...actual, channelWatchdogEnabled: () => mocks.enabled, channelWatchdogIdentitySettings: () => mocks.settings };
});
vi.mock("@/lib/experience/store-server", () => ({ channelRuntime: () => mocks.runtime }));

import { POST } from "./route";

const URL_BASE = "https://experience.example/internal/ota/v1/watchdog";
const validPayload = () => ({
  iss: "https://accounts.google.com", aud: mocks.settings!.audience, email: mocks.settings!.serviceAccountEmail,
  email_verified: true, exp: Math.floor(Date.now() / 1000) + 300,
});
const request = (init: { authorization?: string; body?: string; headers?: Record<string, string>; query?: string } = {}) => new Request(`${URL_BASE}${init.query ?? ""}`, {
  method: "POST",
  headers: { ...(init.authorization === undefined ? { authorization: "Bearer synthetic.oidc.token" } : init.authorization ? { authorization: init.authorization } : {}), ...init.headers },
  ...(init.body === undefined ? {} : { body: init.body }),
});
const ran = {
  ranAtUtc: "2099-01-01T00:00:00.000Z", skipped: false, opened: 1, escalated: 0, resolved: 0, openIncidents: 1,
  transitions: [{ transition: "opened", kind: "SYNC_OVERDUE", incidentId: "7", providerId: "provider-a", detail: { closePending: 2, openPending: 0 } }],
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.settings = { audience: "https://experience.example/internal/ota/v1/watchdog", serviceAccountEmail: "watchdog@example.iam.gserviceaccount.com" };
  mocks.verifyIdToken.mockResolvedValue({ getPayload: () => validPayload() });
  mocks.runtime = { runWatchdog: vi.fn().mockResolvedValue(ran), authenticateWorker: vi.fn() };
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe("POST /internal/ota/v1/watchdog", () => {
  it("stays closed when the flag is off or the identity settings are incomplete", async () => {
    mocks.enabled = false;
    expect((await POST(request())).status).toBe(404);
    mocks.enabled = true; mocks.settings = null;
    expect((await POST(request())).status).toBe(404);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.runtime!.runWatchdog).not.toHaveBeenCalled();
  });

  it("requires the configured Google service identity and never a cookie or worker bearer", async () => {
    expect((await POST(request({ authorization: "", headers: { cookie: "admin-session=synthetic" } }))).status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    mocks.verifyIdToken.mockRejectedValueOnce(new Error("Wrong recipient"));
    const workerBearer = await POST(request({ authorization: `Bearer ${"w".repeat(43)}` }));
    expect(workerBearer.status).toBe(401);
    expect(mocks.runtime!.authenticateWorker).not.toHaveBeenCalled();
    mocks.verifyIdToken.mockResolvedValueOnce({ getPayload: () => ({ ...validPayload(), email: "other@example.iam.gserviceaccount.com" }) });
    expect((await POST(request())).status).toBe(401);
    mocks.verifyIdToken.mockResolvedValueOnce({ getPayload: () => ({ ...validPayload(), email_verified: false }) });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.runtime!.runWatchdog).not.toHaveBeenCalled();
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic.oidc.token", audience: mocks.settings!.audience });
  });

  it("returns 503 when Google key retrieval is unavailable, without running the store", async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "identity_verification_unavailable" });
    expect(mocks.runtime!.runWatchdog).not.toHaveBeenCalled();
  });

  it("accepts only an empty body or {} within 1 KiB and no query", async () => {
    expect((await POST(request({ body: "{}", headers: { "content-type": "application/json" } }))).status).toBe(200);
    expect((await POST(request({ body: "" }))).status).toBe(200);
    expect((await POST(request({ body: JSON.stringify({ providerId: "provider-a" }), headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect((await POST(request({ body: "[]" }))).status).toBe(400);
    expect((await POST(request({ body: " ".repeat(1025) }))).status).toBe(413);
    expect((await POST(request({ query: "?force=1" }))).status).toBe(400);
  });

  it("returns 503 without a database and never falls back to mock data", async () => {
    mocks.runtime = null;
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "runtime_unavailable" });
  });

  it("runs once, returns counts with no-store, and logs one structured line per transition", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ranAtUtc: ran.ranAtUtc, skipped: false, opened: 1, escalated: 0, resolved: 0, openIncidents: 1 });
    expect(mocks.runtime!.runWatchdog).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "ota_runtime_incident", transition: "opened", kind: "SYNC_OVERDUE", incidentId: "7", providerId: "provider-a",
      detail: { closePending: 2, openPending: 0 },
    });
    mocks.runtime!.runWatchdog.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(request())).status).toBe(503);
  });
});
