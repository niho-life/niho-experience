import { StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 設定 › 通知 › 宛先 (#194): the session's own address only. A synthetic session and store. */
const state = vi.hoisted(() => ({
  session: null as null | { accessTokenExpiresAt: number },
  providers: { status: "ok", providers: [{ id: "provider-a", nihoUserId: "owner-a", memberRole: "OWNER" }] } as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ hostNotificationAddresses: () => null }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => state.session, loadHostProviders: async () => state.providers }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: (session: { accessTokenExpiresAt: number }, now: number) => session.accessTokenExpiresAt > now }));

import { changeNotificationAddress, confirmNotificationAddressToken, loadNotificationAddress } from "./notification-address-server";
import { NOTIFICATION_ADDRESS_TEXT } from "./notification-address";

const address = { loginEmail: "login@example.test", overrideEmail: null, effectiveEmail: "login@example.test", pendingEmail: "desk@example.test" };
function store() {
  return {
    get: vi.fn(async () => address),
    requestChange: vi.fn(async () => ({ kind: "PENDING" as const, address })),
    useLoginEmail: vi.fn(async () => ({ ...address, pendingEmail: null })),
    cancelChange: vi.fn(async () => ({ ...address, pendingEmail: null })),
    confirm: vi.fn(async (): Promise<{ email: string } | null> => ({ email: "desk@example.test" })),
  };
}
const TOKEN = "a".repeat(43);

beforeEach(() => {
  state.session = { accessTokenExpiresAt: Date.now() + 60_000 };
  state.providers = { status: "ok", providers: [{ id: "provider-a", nihoUserId: "owner-a", memberRole: "OWNER" }] };
});

describe("the notification address on the server", () => {
  it("reads the person's address, off while this site sends no host email", async () => {
    const s = store();
    expect(await loadNotificationAddress("provider-a", () => null)).toEqual({ status: "off" });
    expect(await loadNotificationAddress("provider-a", () => s)).toEqual({ status: "live", address: { effective: "login@example.test", source: "login", login: "login@example.test", pending: "desk@example.test", preview: false } });
    expect(s.get).toHaveBeenCalledWith("owner-a");
    s.get.mockRejectedValueOnce(new Error("synthetic"));
    expect(await loadNotificationAddress("provider-a", () => s)).toEqual({ status: "error" });
  });

  it("uses only the selected provider's OWNER identity and does not expose it to a cohost", async () => {
    state.providers = { status: "ok", providers: [
      { id: "provider-a", nihoUserId: "owner-a", memberRole: "OWNER" },
      { id: "provider-b", nihoUserId: "owner-b", memberRole: "OWNER" },
    ] };
    const s = store();
    expect(await loadNotificationAddress("provider-b", () => s)).toMatchObject({ status: "live" });
    expect(s.get).toHaveBeenCalledWith("owner-b");

    state.providers = { status: "ok", providers: [{ id: "provider-b", nihoUserId: "owner-b", memberRole: "COHOST" }] };
    const cohostStore = store();
    expect(await loadNotificationAddress("provider-b", () => cohostStore)).toEqual({ status: "error" });
    expect(cohostStore.get).not.toHaveBeenCalled();

    state.providers = { status: "ok", providers: [{ id: "owned-provider", nihoUserId: "owner-a", memberRole: "OWNER" }] };
    const operatorStore = store();
    expect(await loadNotificationAddress("assigned-provider", () => operatorStore)).toMatchObject({ status: "live" });
    expect(operatorStore.get).toHaveBeenCalledWith("owner-a");
  });

  it("changes only the session's own address, with the page's provider, and says why it could not", async () => {
    const s = store();
    expect(await changeNotificationAddress({ kind: "request", providerId: "provider-a", email: " desk@example.test " }, () => s))
      .toMatchObject({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.sent, address: { pending: "desk@example.test" } });
    expect(s.requestChange).toHaveBeenCalledWith({ nihoUserId: "owner-a", providerId: "provider-a", email: "desk@example.test" });
    expect(await changeNotificationAddress({ kind: "request", providerId: "../x", email: "desk@example.test" }, () => s)).toEqual({ ok: false, message: NOTIFICATION_ADDRESS_TEXT.failed });
    expect(await changeNotificationAddress({ kind: "request", providerId: "provider-a", email: "desk" }, () => s)).toEqual({ ok: false, message: NOTIFICATION_ADDRESS_TEXT.invalid });
    s.requestChange.mockRejectedValueOnce(new StoreRateLimitedError(60));
    expect(await changeNotificationAddress({ kind: "request", providerId: "provider-a", email: "desk@example.test" }, () => s)).toEqual({ ok: false, message: NOTIFICATION_ADDRESS_TEXT.rateLimited });
    s.requestChange.mockRejectedValueOnce(new StoreValidationError("synthetic"));
    expect(await changeNotificationAddress({ kind: "request", providerId: "provider-a", email: "desk@example.test" }, () => s)).toEqual({ ok: false, message: NOTIFICATION_ADDRESS_TEXT.invalid });
    s.requestChange.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await changeNotificationAddress({ kind: "request", providerId: "provider-a", email: "desk@example.test" }, () => s)).toEqual({ ok: false, message: NOTIFICATION_ADDRESS_TEXT.failed });
    expect(await changeNotificationAddress({ kind: "login", providerId: "provider-a" }, () => s)).toMatchObject({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.backToLogin });
    expect(s.useLoginEmail).toHaveBeenCalledWith("owner-a");
    expect(await changeNotificationAddress({ kind: "cancel", providerId: "provider-a" }, () => s)).toMatchObject({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.cancelled, address: { pending: null } });
    expect(await changeNotificationAddress({ kind: "cancel", providerId: "provider-a" }, () => null)).toEqual({ ok: false, message: NOTIFICATION_ADDRESS_TEXT.failed });
    // No usable session: nothing is changed.
    state.session = { accessTokenExpiresAt: Date.now() - 1 };
    const before = s.cancelChange.mock.calls.length;
    expect((await changeNotificationAddress({ kind: "cancel", providerId: "provider-a" }, () => s)).ok).toBe(false);
    expect(s.cancelChange.mock.calls.length).toBe(before);
  });

  it("confirms with the link's token, and calls a link that no longer works closed", async () => {
    const s = store();
    expect(await confirmNotificationAddressToken(TOKEN, () => s)).toEqual({ ok: true, email: "desk@example.test" });
    s.confirm.mockResolvedValueOnce(null);
    expect(await confirmNotificationAddressToken(TOKEN, () => s)).toEqual({ ok: false, closed: true });
    s.confirm.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await confirmNotificationAddressToken(TOKEN, () => s)).toEqual({ ok: false, closed: false });
    for (const bad of [undefined, "short", `${TOKEN}=`, "a".repeat(44)]) expect(await confirmNotificationAddressToken(bad, () => s)).toEqual({ ok: false, closed: true });
    expect(await confirmNotificationAddressToken(TOKEN, () => null)).toEqual({ ok: false, closed: true });
    expect(s.confirm).toHaveBeenCalledTimes(3);
  });
});
