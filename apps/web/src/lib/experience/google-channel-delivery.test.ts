import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareDispatch: vi.fn(), prepareReconcile: vi.fn(), prepareObservation: vi.fn(), assertCurrent: vi.fn(), saveResult: vi.fn(), saveRotated: vi.fn(),
  apply: vi.fn(), inspect: vi.fn(), refresh: vi.fn(), open: vi.fn(), seal: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/experience-store", async (original) => {
  const actual = await original<typeof import("@niho-experience/experience-store")>();
  return {
    ...actual,
    GoogleChannelDeliveryRepository: class {
      prepareDispatch = mocks.prepareDispatch;
      prepareReconcile = mocks.prepareReconcile;
      prepareObservation = mocks.prepareObservation;
      assertCurrent = mocks.assertCurrent;
      saveResult = mocks.saveResult;
      saveRotatedRefreshToken = mocks.saveRotated;
    },
  };
});
vi.mock("@niho-experience/google-calendar", async (original) => {
  const actual = await original<typeof import("@niho-experience/google-calendar")>();
  return { ...actual, applyGoogleManagedBlock: mocks.apply, inspectGoogleManagedBlock: mocks.inspect, refreshGoogleToken: mocks.refresh };
});
vi.mock("./google-connection", () => ({
  googleRuntimeConfig: () => ({ google: { clientId: "id", clientSecret: "secret", redirectUri: "https://example.test/callback" }, key: Buffer.alloc(32) }),
}));
vi.mock("./google-token-crypto", () => ({ openGoogleRefreshToken: mocks.open, sealGoogleRefreshToken: mocks.seal }));

import { executeGoogleChannelDelivery } from "./google-channel-delivery";

const snapshot = {
  record: { deliveryId: "00000000-0000-4000-8000-000000000002", phase: "DISPATCHING", airbnb: "UNVERIFIED" },
  context: {
    jobId: "00000000-0000-4000-8000-000000000001", providerId: "provider-a", accountId: "account-a", listingId: "listing-a",
    occurrenceId: "rule@2099-01-01", workerId: "studio-1", leaseEpoch: 1, assignmentVersion: 2,
    action: "SET_CLOSED", accountVersion: 2, bindingVersion: 6, initializeMissingOpenAnchor: false,
    desiredState: "CLOSED", desiredVersion: 4, mappingVersion: 3,
    sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
  },
  storedTarget: {
    providerId: "provider-a", listingId: "listing-a", occurrenceId: "rule@2099-01-01",
    action: "SET_CLOSED", desiredState: "CLOSED", desiredVersion: 4, mappingVersion: 3,
    sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
  },
  targetAuthority: "CURRENT_JOB", operation: "dispatch", operationNonce: "00000000-0000-4000-8000-000000000003",
  calendarId: "private-calendar", connectionGeneration: 5, encryptedRefreshToken: "ciphertext", grantedScopes: [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
    "https://www.googleapis.com/auth/calendar.app.created",
  ], canDispatch: true,
} as const;
const google = {
  eventId: "event", etag: '"etag"', bindingHash: "binding", mappingVersion: 3, desiredVersion: 4,
  startAtUtc: snapshot.context.sourceStartAtUtc, endAtUtc: snapshot.context.sourceEndAtUtc,
  desiredState: "CLOSED", transparency: "opaque", visibility: "private",
} as const;

describe("Google channel server executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareDispatch.mockResolvedValue(snapshot);
    mocks.prepareReconcile.mockResolvedValue(snapshot);
    mocks.prepareObservation.mockResolvedValue({ ...snapshot, operation: "observe", canDispatch: false });
    mocks.open.mockReturnValue("refresh-secret");
    mocks.seal.mockReturnValue("rotated-ciphertext");
    mocks.refresh.mockResolvedValue({ accessToken: "access-secret", expiresAtUtc: "2099-01-01T01:00:00.000Z", scopes: ["scope"] });
    mocks.saveRotated.mockResolvedValue(true);
    mocks.saveResult.mockImplementation(async (_worker, _job, _lease, deliveryId, _nonce, _operation, result) => ({
      deliveryId, phase: result.phase, ...(result.reason ? { reason: result.reason } : {}), airbnb: "UNVERIFIED",
    }));
  });

  it("dispatches through the managed helper only after the durable snapshot and keeps Airbnb unverified", async () => {
    mocks.apply.mockImplementation(async (_config, _token, _calendar, _target, assertCurrent) => {
      await assertCurrent();
      return { code: "GOOGLE_VERIFIED", eventId: "event", changed: true, writeAcknowledged: true, google };
    });
    const result = await executeGoogleChannelDelivery({} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "dispatch");
    expect(mocks.prepareDispatch).toHaveBeenCalledBefore(mocks.refresh);
    expect(mocks.assertCurrent).toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), "access-secret", "private-calendar",
      expect.objectContaining({ listingOpaqueId: "listing-a" }), expect.any(Function), { initializeMissingOpenAnchor: false });
    expect(mocks.saveResult).toHaveBeenCalledWith(expect.anything(), snapshot.context.jobId, "lease", snapshot.record.deliveryId,
      snapshot.operationNonce, "dispatch",
      expect.objectContaining({ phase: "GOOGLE_VERIFIED", changed: true, writeAcknowledged: true }));
    expect(result).toEqual({ deliveryId: snapshot.record.deliveryId, phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED" });
    expect(JSON.stringify(result)).not.toContain("private-calendar");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("never calls the write helper for reconcile", async () => {
    mocks.inspect.mockResolvedValue({ code: "NOT_MATCHED", eventId: "event", reason: "FOREIGN_EVENT" });
    const result = await executeGoogleChannelDelivery({} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "reconcile");
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(result).toEqual({ deliveryId: snapshot.record.deliveryId, phase: "NOT_MATCHED", reason: "FOREIGN_EVENT", airbnb: "UNVERIFIED" });
  });

  it("always performs a fresh GET and never a business write for observe", async () => {
    mocks.inspect.mockResolvedValue({ code: "GOOGLE_VERIFIED", eventId: "event", google });
    const result = await executeGoogleChannelDelivery(
      {} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "observe",
    );
    expect(mocks.prepareObservation).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.saveResult).toHaveBeenCalledWith(expect.anything(), snapshot.context.jobId, "lease", snapshot.record.deliveryId,
      snapshot.operationNonce, "observe", expect.objectContaining({ phase: "GOOGLE_VERIFIED", changed: false, writeAcknowledged: false }));
    expect(result.phase).toBe("GOOGLE_VERIFIED");
  });

  it.each(["configuration", "refresh"] as const)("records observe %s failures as stopped, never uncertain", async (failure) => {
    if (failure === "refresh") mocks.refresh.mockRejectedValueOnce(new Error("synthetic read failure"));
    const result = await executeGoogleChannelDelivery(
      {} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "observe",
      failure === "configuration" ? { runtimeConfig: () => null } : undefined,
    );
    expect(result.phase).toBe("STOPPED");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("records observe GET mismatch as not matched and read failure as stopped", async () => {
    mocks.inspect.mockResolvedValueOnce({ code: "NOT_MATCHED", eventId: "event", reason: "ANCHOR_MISSING" });
    const missing = await executeGoogleChannelDelivery(
      {} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "observe",
    );
    expect(missing).toMatchObject({ phase: "NOT_MATCHED", reason: "ANCHOR_MISSING" });
    mocks.inspect.mockRejectedValueOnce(new Error("synthetic timeout"));
    const timeout = await executeGoogleChannelDelivery(
      {} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "observe",
    );
    expect(timeout).toMatchObject({ phase: "STOPPED", reason: "GOOGLE_UNAVAILABLE" });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("does not issue token or Google I/O for a duplicate dispatch", async () => {
    mocks.prepareDispatch.mockResolvedValue({ ...snapshot, canDispatch: false, record: { ...snapshot.record, phase: "UNCERTAIN", reason: "WRITE_UNCERTAIN" } });
    const result = await executeGoogleChannelDelivery({} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "dispatch");
    expect(result.phase).toBe("UNCERTAIN");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it.each(["configuration", "scope", "refresh"] as const)("keeps the original write uncertain when reconciliation fails at %s", async (failure) => {
    if (failure === "scope") mocks.prepareReconcile.mockResolvedValue({ ...snapshot, grantedScopes: [] });
    if (failure === "refresh") mocks.refresh.mockRejectedValueOnce(new Error("synthetic transient failure"));
    const result = await executeGoogleChannelDelivery(
      {} as never, {} as never, { workerId: "studio-1", credentialVersion: 1 }, snapshot.context.jobId, "lease", "reconcile",
      failure === "configuration" ? { runtimeConfig: () => null } : undefined,
    );
    expect(result.phase).toBe("UNCERTAIN");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});
