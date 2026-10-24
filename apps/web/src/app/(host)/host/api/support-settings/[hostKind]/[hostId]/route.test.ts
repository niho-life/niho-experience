import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), load: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/host/support-settings-server", () => ({
  isHostSupportSettingsEnabled: mocks.enabled,
  loadHostSupportSettingsClient: mocks.load,
  hostSupportSettingsFailureJson: (failure: { kind: string; status?: number }) => Response.json({ error: failure.kind }, { status: failure.kind === "conflict" ? 409 : failure.status === 401 ? 401 : failure.status === 403 ? 403 : 503, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/host/server", () => ({
  siteOrigin: mocks.origin,
  hostNotFound: () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } }),
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
import { GET, PUT } from "./route";

const SITE = "https://experience.example";
const context = (hostKind = "SPOT", hostId = "spot-1") => ({ params: Promise.resolve({ hostKind, hostId }) });
const state = { host: { kind: "SPOT", id: "spot-1", displayName: "通常拠点" }, setting: null, settingState: "UNSET", policy: { policyVersion: "2026-10-23", consentVersion: "2026-10-23", offTotalRateBps: 1000, onTotalRateBps: 1500, peopleCostPaidDirectlyByHost: true, processingFeesIncluded: true }, writeCapability: { writable: true, reason: null } };
const command = { enabled: true, consentVersion: "2026-10-23", expectedRevision: 0 };
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("Host support settings target fixed BFF", () => {
  const get = vi.fn(async () => ({ ok: true, data: state }));
  const put = vi.fn(async () => ({ ok: true, data: { ...state, settingState: "CURRENT" } }));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.origin.mockReturnValue(SITE);
    mocks.load.mockResolvedValue({ ok: true, client: { get, put } });
    get.mockResolvedValue({ ok: true, data: state });
    put.mockResolvedValue({ ok: true, data: { ...state, settingState: "CURRENT" } });
  });

  it("stays closed when OFF and rejects query or malformed target before loading session", async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await GET(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`), context())).status).toBe(404);
    mocks.enabled.mockReturnValue(true);
    expect((await GET(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1?x=1`), context())).status).toBe(400);
    expect((await GET(new Request(`${SITE}/host/api/support-settings/ADMIN/spot-1`), context("ADMIN"))).status).toBe(400);
    expect((await GET(new Request(`${SITE}/host/api/support-settings/SPOT/bad`), context("SPOT", "a/b"))).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("supports both fixed kinds and keeps responses private/no-store", async () => {
    const response = await GET(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(get).toHaveBeenCalledWith("SPOT", "spot-1");
    await GET(new Request(`${SITE}/host/api/support-settings/EXPERIENCE_PROVIDER/provider-1`), context("EXPERIENCE_PROVIDER", "provider-1"));
    expect(get).toHaveBeenLastCalledWith("EXPERIENCE_PROVIDER", "provider-1");
  });

  it("requires exact same-origin and application/json for PUT", async () => {
    const body = JSON.stringify(command);
    expect((await PUT(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`, { method: "PUT", headers: { ...sameOrigin, origin: "https://evil.example" }, body }), context())).status).toBe(403);
    expect((await PUT(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`, { method: "PUT", headers: { ...sameOrigin, "sec-fetch-site": "same-site" }, body }), context())).status).toBe(403);
    expect((await PUT(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`, { method: "PUT", headers: { ...sameOrigin, "content-type": "text/plain" }, body }), context())).status).toBe(415);
    expect(put).not.toHaveBeenCalled();
  });

  it("enforces actual stream bytes and strict command keys", async () => {
    const oversized = JSON.stringify({ ...command, padding: "x".repeat(5000) });
    expect((await PUT(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`, { method: "PUT", headers: sameOrigin, body: oversized }), context())).status).toBe(413);
    expect((await PUT(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`, { method: "PUT", headers: sameOrigin, body: JSON.stringify({ ...command, extra: true }) }), context())).status).toBe(400);
    expect((await PUT(new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`, { method: "PUT", headers: sameOrigin, body: new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]) }), context())).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it("forwards only the validated immutable command and preserves 409/401/403", async () => {
    const request = () => new Request(`${SITE}/host/api/support-settings/SPOT/spot-1`, { method: "PUT", headers: sameOrigin, body: JSON.stringify(command) });
    expect((await PUT(request(), context())).status).toBe(200);
    expect(put).toHaveBeenCalledWith("SPOT", "spot-1", command);
    for (const failure of [{ kind: "conflict" }, { kind: "rejected", status: 401 }, { kind: "rejected", status: 403 }]) {
      put.mockResolvedValueOnce({ ok: false, ...failure } as never);
      expect((await PUT(request(), context())).status).toBe(failure.kind === "conflict" ? 409 : failure.status);
    }
  });
});
