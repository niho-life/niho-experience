import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreValidationError, type HostActor, type HostNotificationChanges } from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";

/** 設定 › 通知 against a stubbed experience store and NIHO provider list (#109). */
const state = vi.hoisted(() => ({
  enabled: true,
  store: null as null | { get: (actor: HostActor) => Promise<unknown>; update: (actor: HostActor, changes: HostNotificationChanges) => Promise<unknown> },
  session: null as null | { kind: "niho"; nihoUserId: string; accessTokenExpiresAt: number } | { kind: "experience"; hostAccountId: string },
  sessionError: null as Error | null,
  providers: { status: "ok", providers: [] } as { status: string; providers?: Pick<HostProvider, "id" | "memberRole">[] },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return { hostNotificationSettingsEnabled: state.enabled }; } }));
vi.mock("@/lib/experience/store-server", () => ({ providerNotificationSettings: () => state.store }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => { if (state.sessionError) throw state.sessionError; return state.session; }, loadHostProviders: async () => state.providers }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: (session: { kind: string; accessTokenExpiresAt?: number }, now: number) => session.kind === "experience" || (session.accessTokenExpiresAt ?? 0) > now }));

import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { changeNotificationSettings, loadNotificationSettings } from "./notification-settings-server";
import { NOTIFICATION_OWNER_ONLY_TEXT, NOTIFICATION_SAVE_FAILED_TEXT } from "./notifications";

const ITEMS = [{ key: "NEW_REVIEW", enabled: false, locked: false }];
const OWNER = { id: "sample-provider", nihoUserId: "sample-niho-user", memberRole: "OWNER" } as HostProvider;
const calls: { method: string; actor: HostActor; changes?: HostNotificationChanges }[] = [];

function storeAnswering(answer: () => Promise<unknown>) {
  state.store = {
    get: (actor) => (calls.push({ method: "get", actor }), answer()),
    update: (actor, changes) => (calls.push({ method: "update", actor, changes }), answer()),
  };
}

beforeEach(() => {
  state.enabled = true;
  calls.length = 0;
  storeAnswering(async () => ITEMS);
  state.session = { kind: "niho", nihoUserId: "sample-niho-user", accessTokenExpiresAt: Date.now() + 60_000 };
  state.sessionError = null;
  state.providers = { status: "ok", providers: [OWNER, { id: "sample-other", memberRole: "EDITOR" }] };
});

describe("loadNotificationSettings", () => {
  it("reads the owner's settings as the OWNER NIHO says this account is", async () => {
    expect(await loadNotificationSettings(OWNER)).toEqual({ status: "live", items: ITEMS });
    expect(calls).toEqual([{ method: "get", actor: { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" } }]);
  });

  it("distinguishes a disabled flag, a non-owner, a missing store and a revoked DB membership", async () => {
    state.enabled = false;
    expect(await loadNotificationSettings(OWNER)).toEqual({ status: "disabled" });
    state.enabled = true;
    expect(await loadNotificationSettings({ ...OWNER, memberRole: "EDITOR" })).toEqual({ status: "forbidden" });
    storeAnswering(async () => Promise.reject(new StoreAccessDeniedError()));
    expect(await loadNotificationSettings(OWNER)).toEqual({ status: "forbidden" });
    state.store = null;
    expect(await loadNotificationSettings(OWNER)).toEqual({ status: "unavailable" });
  });

  it("says the settings could not be read when the DB fails", async () => {
    storeAnswering(async () => Promise.reject(new Error("synthetic outage")));
    expect(await loadNotificationSettings(OWNER)).toEqual({ status: "error" });
  });

  it("reads a native OWNER using the hst account and keeps the saved value on reload", async () => {
    const nativeOwner = { ...OWNER, nihoUserId: "hst_00000000000000000000000000000001" };
    let current = ITEMS;
    state.session = { kind: "experience", hostAccountId: nativeOwner.nihoUserId };
    state.providers = { status: "ok", providers: [nativeOwner] };
    state.store = {
      get: async (actor) => (calls.push({ method: "get", actor }), current),
      update: async (actor, changes) => {
        calls.push({ method: "update", actor, changes });
        current = [{ key: "NEW_REVIEW", enabled: changes.NEW_REVIEW ?? false, locked: false }];
        return current;
      },
    };
    expect(await loadNotificationSettings(nativeOwner)).toEqual({ status: "live", items: ITEMS });
    expect(await changeNotificationSettings(nativeOwner.id, { NEW_REVIEW: true })).toMatchObject({ ok: true, items: [{ key: "NEW_REVIEW", enabled: true }] });
    expect(await loadNotificationSettings(nativeOwner)).toMatchObject({ status: "live", items: [{ key: "NEW_REVIEW", enabled: true }] });
    expect(calls.map((call) => call.actor.nihoUserId)).toEqual([nativeOwner.nihoUserId, nativeOwner.nihoUserId, nativeOwner.nihoUserId]);
  });
});

describe("changeNotificationSettings", () => {
  it("saves the changes for the owner and answers the settings as they are now", async () => {
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: true, message: "保存しました", items: ITEMS });
    expect(calls).toEqual([{ method: "update", actor: { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" }, changes: { NEW_REVIEW: false } }]);
  });

  it("asks for a sign-in when the session has ended", async () => {
    state.session = null;
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { kind: "niho", nihoUserId: "sample-niho-user", accessTokenExpiresAt: Date.now() - 1 };
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    expect(calls).toEqual([]);
  });

  it("does not turn a session read failure into a save success", async () => {
    state.sessionError = new Error("synthetic session store outage");
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: NOTIFICATION_SAVE_FAILED_TEXT });
    expect(calls).toEqual([]);
  });

  it("changes nothing unless NIHO and the experience DB both say this account is the OWNER", async () => {
    for (const providerId of ["sample-other", "sample-unknown"]) {
      expect(await changeNotificationSettings(providerId, { NEW_REVIEW: false })).toEqual({ ok: false, message: NOTIFICATION_OWNER_ONLY_TEXT });
    }
    expect(calls).toEqual([]);
    storeAnswering(async () => Promise.reject(new StoreAccessDeniedError()));
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: NOTIFICATION_OWNER_ONLY_TEXT });
  });

  it("tells the host it was not saved when closed, NIHO's list or the DB fails, or the store refuses the input", async () => {
    state.enabled = false;
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: NOTIFICATION_SAVE_FAILED_TEXT });
    state.enabled = true;
    storeAnswering(async () => Promise.reject(new StoreValidationError("synthetic")));
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    storeAnswering(async () => Promise.reject(new Error("synthetic outage")));
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: NOTIFICATION_SAVE_FAILED_TEXT });
    state.providers = { status: "error" };
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: NOTIFICATION_SAVE_FAILED_TEXT });
    state.store = null;
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: NOTIFICATION_SAVE_FAILED_TEXT });
  });
});
