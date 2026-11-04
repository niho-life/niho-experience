import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({ pool: {}, hostActor: vi.fn(), repository: { getProviderSupportSettings: vi.fn(), setProviderSupportSettings: vi.fn() } }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => mocks.pool }));
vi.mock("@/lib/experience/host-actor", () => ({ hostActor: mocks.hostActor }));
vi.mock("@niho-experience/experience-store", async () => {
  const actual = await vi.importActual<typeof import("@niho-experience/experience-store")>("@niho-experience/experience-store");
  return { ...actual, GuestBookingRepository: class {
    getProviderSupportSettings(...args: unknown[]) { return mocks.repository.getProviderSupportSettings(...args); }
    setProviderSupportSettings(...args: unknown[]) { return mocks.repository.setProviderSupportSettings(...args); }
  } };
});
vi.mock("@/lib/host/relay", () => ({ mutationFromSameOrigin: (_method: string, headers: Headers) => headers.get("origin") === "https://experience.example" && headers.get("sec-fetch-site") === "same-origin" }));
vi.mock("@/lib/host/server", () => ({ noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }), siteOrigin: () => "https://experience.example" }));

import { GET, PUT } from "./route";

const BASE = "https://experience.example/host/api/experience-support-settings/provider-a";
const context = { params: Promise.resolve({ providerId: "provider-a" }) };
const owner = { providerId: "provider-a", nihoUserId: "owner-a" };
const setting = { providerId: "provider-a", supportEnabled: true, platformFeeBasisPoints: 1500, supportConsentVersion: "2026-10-23", supportAgreementRevision: 2, version: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hostActor.mockResolvedValue({ actor: owner, nihoRole: "OWNER" });
  mocks.repository.getProviderSupportSettings.mockResolvedValue(setting);
  mocks.repository.setProviderSupportSettings.mockResolvedValue(setting);
});

describe("Experience host support settings API", () => {
  it("is OWNER-only and returns a private current setting", async () => {
    const response = await GET(new Request(BASE), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.repository.getProviderSupportSettings).toHaveBeenCalledWith(owner);
    mocks.hostActor.mockResolvedValueOnce({ actor: owner, nihoRole: "EDITOR" });
    expect((await GET(new Request(BASE), context)).status).toBe(403);
  });

  it("requires same-origin JSON and forwards only the current consent command", async () => {
    const invalidOrigin = new Request(BASE, { method: "PUT", headers: { origin: "https://other.example", "content-type": "application/json" }, body: "{}" });
    expect((await PUT(invalidOrigin, context)).status).toBe(403);
    const body = { supportEnabled: false, expectedVersion: 2, consentVersion: "2026-10-23" };
    const response = await PUT(new Request(BASE, { method: "PUT", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) }), context);
    expect(response.status).toBe(200);
    expect(mocks.repository.setProviderSupportSettings).toHaveBeenCalledWith(owner, body);
    mocks.repository.setProviderSupportSettings.mockRejectedValueOnce(new StoreConflictError("version"));
    expect((await PUT(new Request(BASE, { method: "PUT", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) }), context)).status).toBe(409);
    expect((await PUT(new Request(`${BASE}?extra=1`, { method: "PUT", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) }), context)).status).toBe(400);
  });
});
