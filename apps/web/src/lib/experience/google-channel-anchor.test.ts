import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ config: { apiMode: "http", hostConsoleEnabled: true } }));
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(), cancelPreparing: vi.fn(), get: vi.fn(), markInitializing: vi.fn(), assertCurrent: vi.fn(),
  saveVerified: vi.fn(), failBefore: vi.fn(), saveStopped: vi.fn(), saveUncertain: vi.fn(),
  assertOwner: vi.fn(), saveRotated: vi.fn(), initialize: vi.fn(), inspect: vi.fn(), refresh: vi.fn(),
  open: vi.fn(), seal: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@niho-experience/experience-store", async (original) => {
  const actual = await original<typeof import("@niho-experience/experience-store")>();
  return { ...actual, GoogleChannelAnchorRepository: class {
    prepare = mocks.prepare; cancelPreparing = mocks.cancelPreparing; get = mocks.get; markInitializing = mocks.markInitializing;
    assertCurrent = mocks.assertCurrent; saveVerified = mocks.saveVerified;
    failBeforeInitialize = mocks.failBefore; saveStopped = mocks.saveStopped;
    saveUncertain = mocks.saveUncertain; assertCurrentOwnerAccess = mocks.assertOwner;
    saveRotatedRefreshToken = mocks.saveRotated;
  } };
});
vi.mock("@niho-experience/google-calendar", async (original) => {
  const actual = await original<typeof import("@niho-experience/google-calendar")>();
  return {
    ...actual, initializeGoogleManagedBlock: mocks.initialize,
    inspectGoogleManagedBlock: mocks.inspect, refreshGoogleToken: mocks.refresh,
  };
});
vi.mock("./google-connection", () => ({
  googleRuntimeConfig: () => ({ google: { clientId: "id", clientSecret: "secret", redirectUri: "https://example.test/callback" }, key: Buffer.alloc(32) }),
}));
vi.mock("./google-token-crypto", () => ({ openGoogleRefreshToken: mocks.open, sealGoogleRefreshToken: mocks.seal }));

import { executeGoogleChannelAnchor, googleChannelAnchorDto, googleChannelAnchorEnabled } from "./google-channel-anchor";

const originalFlag = process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED;
const actor = { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" } as const;
const input = {
  listingId: "listing-a", occurrenceId: "rule-a@2030-01-01", expectedMappingVersion: 3,
  expectedDesiredVersion: 7, commandId: "00000000-0000-4000-8000-000000000278", operation: "initialize" as const,
};
const snapshot = {
  record: { commandId: input.commandId, listingId: input.listingId, occurrenceId: input.occurrenceId, state: "PREPARING" },
  providerId: actor.providerId, accountId: "account-a", actorNihoUserId: actor.nihoUserId,
  operation: "initialize", operationNonce: "nonce", operationEpoch: 1, accountVersion: 2,
  mappingVersion: 3, bindingVersion: 1, connectionGeneration: 4,
  bindingCalendarDigest: "digest", grantedScopesDigest: "scope-digest", desiredState: "OPEN", desiredVersion: 7,
  sourceStartAtUtc: "2030-01-01T01:00:00.000Z", sourceEndAtUtc: "2030-01-01T02:00:00.000Z",
  calendarId: "private-calendar", encryptedRefreshToken: "ciphertext", grantedScopes: [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
    "https://www.googleapis.com/auth/calendar.app.created",
  ], canPerform: true,
} as const;
const google = {
  eventId: "event", etag: '"etag"', bindingHash: "binding", mappingVersion: 3, desiredVersion: 7,
  startAtUtc: snapshot.sourceStartAtUtc, endAtUtc: snapshot.sourceEndAtUtc,
  desiredState: "OPEN", transparency: "transparent", visibility: "private",
} as const;

describe("Google channel anchor server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config.apiMode = "http"; state.config.hostConsoleEnabled = true;
    mocks.prepare.mockResolvedValue(snapshot);
    mocks.open.mockReturnValue("refresh-secret");
    mocks.refresh.mockResolvedValue({ accessToken: "access-secret", expiresAtUtc: "2030-01-01T00:00:00.000Z", scopes: snapshot.grantedScopes });
    mocks.saveRotated.mockResolvedValue(true);
    mocks.assertOwner.mockResolvedValue(undefined);
    mocks.saveVerified.mockResolvedValue({ ...snapshot.record, state: "GOOGLE_VERIFIED" });
    mocks.saveUncertain.mockImplementation(async (_snapshot, reason) => ({ ...snapshot.record, state: "UNCERTAIN", reason }));
    mocks.saveStopped.mockImplementation(async (_snapshot, reason) => ({ ...snapshot.record, state: "FAILED_BEFORE_INITIALIZE", reason }));
    mocks.failBefore.mockImplementation(async (_snapshot, reason) => ({ ...snapshot.record, state: "FAILED_BEFORE_INITIALIZE", reason }));
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED;
    else process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED = originalFlag;
  });

  it("shares the default-off setup gate and selects no Google metadata", () => {
    delete process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED;
    expect(googleChannelAnchorEnabled()).toBe(false);
    process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED = "true";
    state.config.hostConsoleEnabled = false;
    expect(googleChannelAnchorEnabled()).toBe(false);
    expect(googleChannelAnchorDto({ ...snapshot.record, state: "GOOGLE_VERIFIED", eventId: "secret", token: "secret" } as never))
      .toEqual({ commandId: input.commandId, listingId: input.listingId, occurrenceId: input.occurrenceId, state: "GOOGLE_VERIFIED" });
  });

  it("records INITIALIZING before the insert-only helper and saves selected verification", async () => {
    mocks.initialize.mockImplementation(async (_config, _token, _calendar, _target, assertCurrent) => {
      await assertCurrent();
      return { code: "GOOGLE_VERIFIED", eventId: "event", changed: true, writeAcknowledged: true, google };
    });
    const result = await executeGoogleChannelAnchor({} as never, actor, input);
    expect(mocks.markInitializing).toHaveBeenCalledBefore(mocks.initialize);
    expect(mocks.initialize).toHaveBeenCalledWith(expect.anything(), "access-secret", "private-calendar", expect.objectContaining({ desiredState: "OPEN" }), expect.any(Function));
    expect(mocks.assertCurrent).toHaveBeenCalled();
    expect(mocks.saveVerified).toHaveBeenCalledWith(snapshot, google, true, true);
    expect(result.state).toBe("GOOGLE_VERIFIED");
  });

  it("never performs Google I/O on same-command initialize replay", async () => {
    mocks.prepare.mockResolvedValue({ ...snapshot, canPerform: false, record: { ...snapshot.record, state: "UNCERTAIN", reason: "WRITE_UNCERTAIN" } });
    const result = await executeGoogleChannelAnchor({} as never, actor, input);
    expect(result.state).toBe("UNCERTAIN");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("uses GET-only inspection and keeps missing/error outcomes uncertain", async () => {
    const inspectSnapshot = { ...snapshot, operation: "inspect", record: { ...snapshot.record, state: "UNCERTAIN" } } as const;
    mocks.prepare.mockResolvedValue(inspectSnapshot);
    mocks.inspect.mockResolvedValue({ code: "NOT_MATCHED", eventId: "event", reason: "ANCHOR_MISSING" });
    const result = await executeGoogleChannelAnchor({} as never, actor, { ...input, operation: "inspect" });
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.saveUncertain).toHaveBeenCalledWith(inspectSnapshot, "ANCHOR_MISSING");
    expect(result.state).toBe("UNCERTAIN");
  });

  it("keeps inspection uncertain when configuration or token refresh fails", async () => {
    const inspectSnapshot = { ...snapshot, operation: "inspect", record: { ...snapshot.record, state: "UNCERTAIN" } } as const;
    mocks.prepare.mockResolvedValue(inspectSnapshot);
    const unavailable = await executeGoogleChannelAnchor(
      {} as never, actor, { ...input, operation: "inspect" }, { runtimeConfig: () => null },
    );
    expect(unavailable).toMatchObject({ state: "UNCERTAIN", reason: "CONFIG_UNAVAILABLE" });
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});
