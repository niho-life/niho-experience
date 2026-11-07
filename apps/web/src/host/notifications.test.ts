import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_LOAD_FAILED_TEXT,
  NOTIFICATION_OWNER_ONLY_TEXT,
  notificationChanges,
  notificationChangesInput,
  notificationPanelView,
  notificationRows,
  NOTIFICATIONS,
  STOPPABLE_NOTIFICATION_KEYS,
  toggleNotification,
} from "./notifications";
import type { HostNotificationItem, HostNotificationSettings } from "./types";

/** The host-facing notification set: the keys in order, with only guest messages, summaries and reviews stoppable. */
const AS_NIHO_ANSWERS: HostNotificationItem[] = NOTIFICATIONS.map(({ key, stoppable }) => ({ key, enabled: true, locked: !stoppable }));
const SETTINGS: HostNotificationSettings = { email: { addresses: ["owner@example.com"] }, items: AS_NIHO_ANSWERS };

describe("notification definitions", () => {
  it("lists host notifications in order, with their words, and only three can be stopped", () => {
    expect(NOTIFICATIONS.map(({ key, label, when, stoppable }) => [key, label, when, stoppable])).toEqual([
      ["NEW_BOOKING", "新しい予約・申込", "承認待ちの申込と予約の確定 · すぐに", false],
      ["CANCELLATION", "予約の取消", "予約者の取消・取消の依頼・期限切れ", false],
      ["GUEST_MESSAGE", "予約前の質問・予約者からの連絡", "日本語訳つきで届きます", true],
      ["DAY_BEFORE_SUMMARY", "前日の参加者のまとめ", "毎日 18:00 · 翌日に確定の予約があるときだけ", true],
      ["NEW_REVIEW", "新しいレビュー", "投稿されたとき · すぐに", true],
      ["EMAIL_DELIVERY_FAILED", "予約者へのメールの不達", "相手のメールサーバーが不達を返したとき", false],
      ["LISTING_SUSPENSION", "掲載の運営停止・解除", "運営が掲載を止めたとき・止めた掲載を戻せるようになったとき", false],
    ]);
    expect(NOTIFICATIONS.filter((definition) => definition.stoppable).map((definition) => definition.key)).toEqual([...STOPPABLE_NOTIFICATION_KEYS]);
  });
});

describe("notificationRows", () => {
  it("shows NIHO's answer as it is", () => {
    const rows = notificationRows(AS_NIHO_ANSWERS.map((item) => (item.key === "NEW_REVIEW" ? { ...item, enabled: false } : item)));
    expect(rows.map(({ key, enabled, locked }) => [key, enabled, locked])).toEqual([
      ["NEW_BOOKING", true, true],
      ["CANCELLATION", true, true],
      ["GUEST_MESSAGE", true, false],
      ["DAY_BEFORE_SUMMARY", true, false],
      ["NEW_REVIEW", false, false],
      ["EMAIL_DELIVERY_FAILED", true, true],
      ["LISTING_SUSPENSION", true, true],
    ]);
  });

  it("keeps NIHO's order, drops keys it does not know and fills in missing ones as NIHO starts them", () => {
    const rows = notificationRows([
      { key: "NEW_REVIEW", enabled: false, locked: false },
      { key: "SOMETHING_NEW", enabled: true, locked: false },
      { key: "GUEST_MESSAGE", enabled: false, locked: false },
    ]);
    expect(rows.map((row) => row.key)).toEqual(NOTIFICATIONS.map((definition) => definition.key));
    expect(rows.map(({ key, enabled, locked }) => [key, enabled, locked])).toEqual([
      ["NEW_BOOKING", true, true],
      ["CANCELLATION", true, true],
      ["GUEST_MESSAGE", false, false],
      ["DAY_BEFORE_SUMMARY", true, false],
      ["NEW_REVIEW", false, false],
      ["EMAIL_DELIVERY_FAILED", true, true],
      ["LISTING_SUSPENSION", true, true],
    ]);
    expect(notificationRows([])).toEqual(notificationRows(AS_NIHO_ANSWERS));
  });

  it("trusts NIHO's lock on a notification the host could stop, and always locks the ones the host cannot", () => {
    const rows = notificationRows([
      { key: "DAY_BEFORE_SUMMARY", enabled: false, locked: true },
      // An answer outside the spec cannot turn off (or unlock) a notification that always comes.
      { key: "NEW_BOOKING", enabled: false, locked: false },
      { key: "LISTING_SUSPENSION", enabled: false, locked: true },
    ]);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, [row.enabled, row.locked]]));
    expect(byKey.DAY_BEFORE_SUMMARY).toEqual([false, true]);
    expect(byKey.NEW_BOOKING).toEqual([true, true]);
    expect(byKey.LISTING_SUSPENSION).toEqual([true, true]);
  });
});

describe("changing notifications", () => {
  const rows = notificationRows(AS_NIHO_ANSWERS);

  it("turns a notification the host may stop on and off, and leaves a locked one as it is", () => {
    const off = toggleNotification(rows, "NEW_REVIEW", false);
    expect(off.find((row) => row.key === "NEW_REVIEW")?.enabled).toBe(false);
    expect(toggleNotification(rows, "NEW_BOOKING", false)).toEqual(rows);
    const lockedByNiho = notificationRows([{ key: "GUEST_MESSAGE", enabled: true, locked: true }]);
    expect(toggleNotification(lockedByNiho, "GUEST_MESSAGE", false)).toEqual(lockedByNiho);
  });

  it("sends only the stoppable notifications that changed, as booleans", () => {
    expect(notificationChanges(rows, rows)).toEqual({});
    const now = toggleNotification(toggleNotification(rows, "NEW_REVIEW", false), "DAY_BEFORE_SUMMARY", false);
    expect(notificationChanges(rows, now)).toEqual({ NEW_REVIEW: false, DAY_BEFORE_SUMMARY: false });
    // Turned off and on again: nothing to send.
    expect(notificationChanges(rows, toggleNotification(toggleNotification(rows, "GUEST_MESSAGE", false), "GUEST_MESSAGE", true))).toEqual({});
  });
});

describe("notificationPanelView", () => {
  it("shows the owner the addresses (read-only) and the notification choices; the preview lets them be tried", () => {
    const view = notificationPanelView(SETTINGS, "OWNER", "preview");
    expect(view).toMatchObject({ kind: "owner", preparing: false, addresses: ["owner@example.com"], addressText: "NIHO からの通知はこのメールに届きます" });
    expect(view.kind === "owner" && view.rows).toEqual(notificationRows(AS_NIHO_ANSWERS));
  });

  it("lets the owner change them once the experience DB keeps them, and is 準備中 until then", () => {
    expect(notificationPanelView(SETTINGS, "OWNER", "live")).toMatchObject({ kind: "owner", preparing: false });
    expect(notificationPanelView(SETTINGS, "OWNER", "preparing")).toMatchObject({ kind: "owner", preparing: true });
    expect(notificationPanelView(null, "EDITOR", "preparing")).toEqual({ kind: "owner-only", text: NOTIFICATION_OWNER_ONLY_TEXT, preparing: true });
  });

  it("says the settings could not be read rather than showing switches that may be wrong", () => {
    expect(notificationPanelView(SETTINGS, "OWNER", "error")).toEqual({ kind: "error", text: NOTIFICATION_LOAD_FAILED_TEXT, preparing: false });
  });

  it("tells anyone but the owner that the settings are the owner's, whatever data came", () => {
    for (const role of ["EDITOR", null] as const) {
      expect(notificationPanelView(SETTINGS, role, "preview"), String(role)).toEqual({ kind: "owner-only", text: "通知の設定はオーナーが変えられます", preparing: false });
      expect(notificationPanelView(SETTINGS, role, "error"), String(role)).toMatchObject({ kind: "owner-only" });
    }
    expect(notificationPanelView(null, "OWNER", "preview")).toMatchObject({ kind: "owner-only" });
  });

  it("names where the mail goes when no address is listed, or several", () => {
    const none = notificationPanelView({ email: { addresses: [" "] }, items: [] }, "OWNER", "preview");
    expect(none).toMatchObject({ addresses: [], addressText: "NIHO からの通知は、ログインで確認したメールアドレスに届きます" });
    const two = notificationPanelView({ email: { addresses: ["a@example.com", "b@example.com"] }, items: [] }, "OWNER", "preview");
    expect(two).toMatchObject({ addresses: ["a@example.com", "b@example.com"], addressText: "NIHO からの通知はこれらのメールに届きます" });
  });
});

describe("notificationChangesInput", () => {
  it("takes one or more of the three stoppable notifications as booleans", () => {
    expect(notificationChangesInput({ NEW_REVIEW: false })).toEqual({ NEW_REVIEW: false });
    expect(notificationChangesInput({ GUEST_MESSAGE: true, DAY_BEFORE_SUMMARY: false, NEW_REVIEW: true })).toEqual({ GUEST_MESSAGE: true, DAY_BEFORE_SUMMARY: false, NEW_REVIEW: true });
  });

  it("refuses anything else the browser might send", () => {
    for (const value of [null, undefined, [], "NEW_REVIEW", {}, { NEW_BOOKING: false }, { NEW_REVIEW: "false" }, { NEW_REVIEW: false, extra: true }]) {
      expect(notificationChangesInput(value), JSON.stringify(value)).toBeNull();
    }
  });
});
