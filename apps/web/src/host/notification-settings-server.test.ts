import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreValidationError, type HostActor, type HostNotificationChanges } from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";

/** 設定 › 通知 against a stubbed experience store and NIHO provider list (#109). */
const state = vi.hoisted(() => ({
  store: null as null | { get: (actor: HostActor) => Promise<unknown>; update: (actor: HostActor, changes: HostNotificationChanges) => Promise<unknown> },
  session: null as null | { nihoUserId: string; idTokenExpiresAt: number },
  providers: { status: "ok", providers: [] } as { status: string; providers?: Pick<HostProvider, "id" | "memberRole">[] },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ providerNotificationSettings: () => state.store }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => state.session, loadHostProviders: async () => state.providers }));
vi.mock("@/lib/host/session", () => ({ idTokenUsable: (session: { idTokenExpiresAt: number }, now: number) => session.idTokenExpiresAt > now }));

import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { changeNotificationSettings, loadNotificationSettings } from "./notification-settings-server";
import { NOTIFICATION_OWNER_ONLY_TEXT, NOTIFICATION_SAVE_FAILED_TEXT } from "./notifications";

const ITEMS = [{ key: "NEW_REVIEW", enabled: false, locked: false }];
const OWNER = { id: "sample-provider", memberRole: "OWNER" } as HostProvider;
const calls: { method: string; actor: HostActor; changes?: HostNotificationChanges }[] = [];

function storeAnswering(answer: () => Promise<unknown>) {
  state.store = {
    get: (actor) => (calls.push({ method: "get", actor }), answer()),
    update: (actor, changes) => (calls.push({ method: "update", actor, changes }), answer()),
  };
}

beforeEach(() => {
  calls.length = 0;
  storeAnswering(async () => ITEMS);
  state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
  state.providers = { status: "ok", providers: [OWNER, { id: "sample-other", memberRole: "EDITOR" }] };
});

describe("loadNotificationSettings", () => {
  it("reads the owner's settings as the OWNER NIHO says this account is", async () => {
    expect(await loadNotificationSettings(OWNER, "sample-niho-user")).toEqual({ status: "live", items: ITEMS });
    expect(calls).toEqual([{ method: "get", actor: { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" } }]);
  });

  it("is 準備中 while closed, for anyone but the owner, and while the experience DB has no OWNER for them", async () => {
    expect(await loadNotificationSettings({ ...OWNER, memberRole: "EDITOR" }, "sample-niho-user")).toEqual({ status: "preparing" });
    storeAnswering(async () => Promise.reject(new StoreAccessDeniedError()));
    expect(await loadNotificationSettings(OWNER, "sample-niho-user")).toEqual({ status: "preparing" });
    state.store = null;
    expect(await loadNotificationSettings(OWNER, "sample-niho-user")).toEqual({ status: "preparing" });
  });

  it("says the settings could not be read when the DB fails", async () => {
    storeAnswering(async () => Promise.reject(new Error("synthetic outage")));
    expect(await loadNotificationSettings(OWNER, "sample-niho-user")).toEqual({ status: "error" });
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
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() - 1 };
    expect(await changeNotificationSettings("sample-provider", { NEW_REVIEW: false })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
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
