import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true, csrf: true, load: vi.fn(), runtime: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({ adminMutationAllowed: () => mocks.csrf, loadAdminHttpSession: mocks.load }));
vi.mock("@/lib/experience/channel-runtime", async () => {
  const actual = await vi.importActual<typeof import("@/lib/experience/channel-runtime")>("@/lib/experience/channel-runtime");
  return { ...actual, channelManagerEnabled: () => mocks.enabled };
});
vi.mock("@/lib/experience/store-server", () => ({ channelRuntime: () => mocks.runtime }));

import { POST } from "./route";

const request = (body: unknown) => new Request("https://experience.example/admin/api/channels", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://experience.example", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.csrf = true;
  mocks.load.mockResolvedValue({ status: "ok", verified: { actor: { id: "verified-admin" } } });
  mocks.runtime = { listExternalAccounts: vi.fn().mockResolvedValue([]), listListings: vi.fn().mockResolvedValue([]) };
});

describe("Admin channel BFF", () => {
  it("checks the dedicated flag, CSRF, and fresh Admin session before the store", async () => {
    mocks.enabled = false;
    expect((await POST(request({ action: "listAccounts", providerId: "provider-a" }))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.enabled = true; mocks.csrf = false;
    expect((await POST(request({ action: "listAccounts", providerId: "provider-a" }))).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.csrf = true; mocks.load.mockResolvedValue({ status: "refresh" });
    expect((await POST(request({ action: "listAccounts", providerId: "provider-a" }))).status).toBe(401);
  });

  it("rejects unknown actions and oversized bodies", async () => {
    expect((await POST(request({ action: "arbitraryQuery", sql: "select *" }))).status).toBe(400);
    expect((await POST(request({ action: "listAccounts", providerId: "p", padding: "x".repeat(17 * 1024) }))).status).toBe(413);
  });

  it("uses the verified actor and strips private profile fields from chosen DTOs", async () => {
    const account = {
      id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-a", displayName: "Account",
      operatingModel: 2, active: false, version: 1, quarantined: false, createdAtUtc: "2099-01-01T00:00:00.000Z", updatedAtUtc: "2099-01-01T00:00:00.000Z",
      privateProfileRef: "must-not-leak", credentialDigest: "must-not-leak",
    };
    mocks.runtime!.listExternalAccounts!.mockResolvedValue([account]);
    const response = await POST(request({ action: "listAccounts", providerId: "provider-a" }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
    expect(mocks.runtime!.listExternalAccounts!).toHaveBeenCalledWith({ nihoUserId: "verified-admin" }, "provider-a");
  });

  it("updates the account target explicitly and rejects private profile input", async () => {
    const account = {
      id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-b", displayName: "Account",
      operatingModel: 2, active: false, version: 2, quarantined: false, createdAtUtc: "2099-01-01T00:00:00.000Z", updatedAtUtc: "2099-01-01T00:00:00.000Z",
    };
    mocks.runtime!.updateExternalAccount = vi.fn().mockResolvedValue(account);
    const input = { id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-b", displayName: "Account", operatingModel: 2, active: false };
    const response = await POST(request({ action: "updateAccount", commandId: "00000000-0000-4000-8000-000000000235", accountId: "account-a", expectedVersion: 1, account: input }));
    expect(response.status).toBe(200);
    expect(mocks.runtime!.updateExternalAccount).toHaveBeenCalledWith({ nihoUserId: "verified-admin" }, "account-a", {
      site: "Airbnb", externalAccountId: "external-b", displayName: "Account", operatingModel: 2, active: false,
    }, 1, "00000000-0000-4000-8000-000000000235");
    expect((await POST(request({ action: "createAccount", commandId: "00000000-0000-4000-8000-000000000236", account: { ...input, privateProfileRef: "profile-secret" } }))).status).toBe(400);
  });

  it("allows only the explicit reservation-read capability field", async () => {
    const listing = {
      id: "listing-a", providerId: "provider-a", accountId: "account-a", productId: "tea",
      externalProductId: "external-tea", timeZone: "Asia/Tokyo", adapter: "browser-v1", adapterVersion: "1",
      connectionMode: "BROWSER", capabilities: { canObserve: true, canReadReservations: true, canClose: false, canOpen: false, canCreate: false },
      active: false, mappingVersion: 1, createdAtUtc: "2099-01-01T00:00:00.000Z", updatedAtUtc: "2099-01-01T00:00:00.000Z",
    };
    mocks.runtime!.createListing = vi.fn().mockResolvedValue(listing);
    const listingInput = {
      id: "listing-a", providerId: "provider-a", accountId: "account-a", productId: "tea",
      externalProductId: "external-tea", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
      capabilities: { canObserve: true, canReadReservations: true }, active: false,
    };
    const response = await POST(request({
      action: "createListing", commandId: "00000000-0000-4000-8000-000000000237",
      listing: listingInput,
    }));
    expect(response.status).toBe(201);
    expect(mocks.runtime!.createListing).toHaveBeenCalledWith(
      { nihoUserId: "verified-admin" }, expect.objectContaining({ capabilities: { canObserve: true, canReadReservations: true } }),
      "00000000-0000-4000-8000-000000000237",
    );
    expect((await POST(request({
      action: "createListing", commandId: randomUUIDForTest,
      listing: { ...listingInput, capabilities: { canObserve: true, canReadReservations: true, customerData: true } },
    }))).status).toBe(400);
  });
});

const randomUUIDForTest = "00000000-0000-4000-8000-000000000238";

describe("Admin channel runtime operations", () => {
  const commandId = "00000000-0000-4000-8000-000000000240";
  const actor = { nihoUserId: "verified-admin" };

  it("returns an allowlisted runtime overview without worker credentials or external account IDs", async () => {
    mocks.runtime!.runtimeOverview = vi.fn().mockResolvedValue({
      providerId: "provider-a", generatedAtUtc: "2099-01-01T00:00:00.000Z", watchdogStale: true, openHold: true, unclosedOccurrences: 2,
      workers: [{ id: "worker-a", displayName: "Studio", health: "DOWN", openHold: true, assignedAccounts: 1, credentialDigest: "must-not-leak" }],
      accounts: [{
        id: "account-a", site: "GetYourGuide", displayName: "Synthetic", active: true, version: 3, quarantineReason: "AUTH_REQUIRED",
        externalAccountId: "must-not-leak", privateProfileRef: "must-not-leak",
        sync: { closePending: 2, openPending: 1, overdue: 1, heldOpen: 1 }, reservationReads: { listings: 1, halted: 1 },
        listings: [{ listingId: "listing-a", productTitle: "Synthetic tea", closePending: 2, openPending: 1, overdue: 1, reservationReads: true, readHalted: true, externalProductId: "must-not-leak" }],
      }],
      incidents: [{ id: "7", kind: "WORKER_STALE", subjectType: "worker", subjectId: "worker-a", openedAtUtc: "2099-01-01T00:00:00.000Z", escalated: true, acknowledged: false, assignedToMe: false, detail: { staleSeconds: 4000 }, assigneeNihoUserId: "must-not-leak" }],
    });
    const response = await POST(request({ action: "runtimeOverview", providerId: "provider-a" }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
    expect(data.overview.accounts[0].quarantineReason).toBe("AUTH_REQUIRED");
    expect(mocks.runtime!.runtimeOverview).toHaveBeenCalledWith(actor, "provider-a");
    expect((await POST(request({ action: "runtimeOverview", providerId: "provider-a", sql: "x" }))).status).toBe(400);
  });

  it("validates pause, re-authentication, reservation retry, and incident ownership inputs exactly", async () => {
    mocks.runtime!.pauseAccount = vi.fn().mockResolvedValue({ accountId: "account-a", quarantineReason: "MANUAL_HANDLING" });
    mocks.runtime!.confirmReauth = vi.fn().mockResolvedValue({ observeJobId: "job" });
    mocks.runtime!.retryReservationReads = vi.fn().mockResolvedValue({ listingId: "listing-a", nextDueAtUtc: "2099-01-01T00:00:00.000Z" });
    mocks.runtime!.acknowledgeIncident = vi.fn().mockResolvedValue({ incidentId: "7", acknowledgedAtUtc: "2099-01-01T00:00:00.000Z" });

    expect((await POST(request({ action: "pauseAccount", commandId, accountId: "account-a", expectedVersion: 3 }))).status).toBe(200);
    expect(mocks.runtime!.pauseAccount).toHaveBeenCalledWith(actor, "account-a", 3, commandId);
    for (const body of [
      { action: "pauseAccount", commandId, accountId: "account-a" },
      { action: "pauseAccount", commandId, accountId: "account-a", expectedVersion: 0 },
      { action: "pauseAccount", commandId: "not-a-uuid", accountId: "account-a", expectedVersion: 3 },
      { action: "pauseAccount", commandId, accountId: "account-a", expectedVersion: 3, reason: "AUTH_REQUIRED" },
    ]) expect((await POST(request(body))).status).toBe(400);

    expect((await POST(request({ action: "confirmReauth", commandId, accountId: "account-a", stopConfirmed: true, reauthConfirmed: true }))).status).toBe(200);
    expect(mocks.runtime!.confirmReauth).toHaveBeenCalledWith(actor, "account-a", true, true, commandId);
    for (const body of [
      { action: "confirmReauth", commandId, accountId: "account-a", stopConfirmed: true },
      { action: "confirmReauth", commandId, accountId: "account-a", stopConfirmed: true, reauthConfirmed: false },
      { action: "confirmReauth", commandId, accountId: "account-a", stopConfirmed: "true", reauthConfirmed: true },
      { action: "confirmReauth", commandId, accountId: "account-a", stopConfirmed: true, reauthConfirmed: true, password: "x" },
    ]) expect((await POST(request(body))).status).toBe(400);

    expect((await POST(request({ action: "retryReservationReads", commandId, listingId: "listing-a" }))).status).toBe(200);
    expect(mocks.runtime!.retryReservationReads).toHaveBeenCalledWith(actor, "listing-a", commandId);
    expect((await POST(request({ action: "retryReservationReads", commandId, listingId: "listing-a", retryCount: 0 }))).status).toBe(400);
    expect((await POST(request({ action: "retryReservationReads", listingId: "listing-a" }))).status).toBe(400);

    expect((await POST(request({ action: "acknowledgeIncident", commandId, incidentId: "7" }))).status).toBe(200);
    expect(mocks.runtime!.acknowledgeIncident).toHaveBeenCalledWith(actor, "7", commandId);
    for (const incidentId of [7, "0", "-1", "7; drop", "1".repeat(19)]) {
      expect((await POST(request({ action: "acknowledgeIncident", commandId, incidentId }))).status).toBe(400);
    }
    expect((await POST(request({ action: "acknowledgeIncident", commandId, incidentId: "7", assignee: "someone-else" }))).status).toBe(400);
    expect((await POST(request({ action: "resolveIncident", commandId, incidentId: "7" }))).status).toBe(400);
    expect(mocks.runtime!.acknowledgeIncident).toHaveBeenCalledTimes(1);
  });

  it("maps a store conflict on a guarded action to 409", async () => {
    const { StoreConflictError } = await import("@niho-experience/experience-store");
    mocks.runtime!.confirmReauth = vi.fn().mockRejectedValue(new StoreConflictError("This account is not waiting for re-authentication."));
    expect((await POST(request({ action: "confirmReauth", commandId, accountId: "account-a", stopConfirmed: true, reauthConfirmed: true }))).status).toBe(409);
  });
});
