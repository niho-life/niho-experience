import type { HostProviderRole } from "@/lib/host/providers";
import type { HostNotificationItem, HostNotificationKey, HostNotificationSettings } from "./types";

/*
 * 設定 › 通知 (#109, Epic #103): the notifications a provider gets, in the order of niho-app spec
 * §17.4, what each one is and when it comes, and which the host may turn off. The experience DB
 * keeps the three the OWNER may stop (ADR 0002, migration 0020) and answers every key in this
 * order; the screen still drops a key it does not know and fills in one that is missing. Plain
 * data and rules (no server code), shared by the settings page, its form and its server action.
 */

export interface NotificationDefinition {
  key: HostNotificationKey;
  label: string;
  /** When it comes, in one line. */
  when: string;
  /** The host may turn it off. The others always come. */
  stoppable: boolean;
}

export const NOTIFICATIONS: readonly NotificationDefinition[] = [
  { key: "NEW_BOOKING", label: "新しい予約・申込", when: "承認待ちの申込と予約の確定 · すぐに", stoppable: false },
  { key: "APPROVAL_DEADLINE", label: "承認の期限が近い", when: "期限の 6 時間前と 1 時間前", stoppable: false },
  { key: "CANCELLATION", label: "予約の取消", when: "予約者の取消・取消の依頼・期限切れ", stoppable: false },
  { key: "GUEST_MESSAGE", label: "予約前の質問・予約者からの連絡", when: "日本語訳つきで届きます", stoppable: true },
  { key: "DAY_BEFORE_SUMMARY", label: "前日の参加者のまとめ", when: "毎日 18:00 · 翌日に確定の予約があるときだけ", stoppable: true },
  { key: "NEW_REVIEW", label: "新しいレビュー", when: "公開される前に届きます", stoppable: true },
  { key: "LISTING_REVIEW", label: "掲載と審査の結果", when: "掲載の承認・差し戻し・停止", stoppable: false },
];

/** The only keys 保存 changes (booleans). */
export const STOPPABLE_NOTIFICATION_KEYS = ["GUEST_MESSAGE", "DAY_BEFORE_SUMMARY", "NEW_REVIEW"] as const satisfies readonly HostNotificationKey[];
export type StoppableNotificationKey = (typeof STOPPABLE_NOTIFICATION_KEYS)[number];

export const NOTIFICATION_LOCKED_TEXT = "止められません";
export const NOTIFICATION_OWNER_ONLY_TEXT = "通知の設定はオーナーが変えられます";
export const NOTIFICATION_ADDRESS_CHANGE_TEXT = "宛先の変更は準備中です";
export const NOTIFICATION_LOAD_FAILED_TEXT = "通知の設定を読み込めませんでした。時間をおいて、ページを読み込み直してください。";
export const NOTIFICATION_SAVE_FAILED_TEXT = "通知の設定を保存できませんでした。時間をおいて、もう一度お試しください。";

/** One row of 通知: the words, and whether it is on and may be changed. */
export interface NotificationRow {
  key: HostNotificationKey;
  label: string;
  when: string;
  enabled: boolean;
  locked: boolean;
}

function isStoppable(key: HostNotificationKey): key is StoppableNotificationKey {
  return (STOPPABLE_NOTIFICATION_KEYS as readonly HostNotificationKey[]).includes(key);
}

/**
 * NIHO's items as the screen's rows, always the seven in NIHO's order: a key the console does not
 * know is dropped, a missing one comes as NIHO starts it (on). NIHO may lock a notification the host
 * could otherwise turn off; one the host can never turn off is always on and locked, whatever came.
 */
export function notificationRows(items: readonly HostNotificationItem[]): NotificationRow[] {
  return NOTIFICATIONS.map(({ key, label, when, stoppable }) => {
    const item = items.find((candidate) => candidate.key === key);
    if (!stoppable) return { key, label, when, enabled: true, locked: true };
    return { key, label, when, enabled: item?.enabled ?? true, locked: item?.locked ?? false };
  });
}

/** Turns one notification on or off; a locked one stays as it is. */
export function toggleNotification(rows: readonly NotificationRow[], key: HostNotificationKey, enabled: boolean): NotificationRow[] {
  return rows.map((row) => (row.key === key && !row.locked ? { ...row, enabled } : row));
}

/** What 保存 sends: only the notifications the host may change, and only those that changed. */
export function notificationChanges(saved: readonly NotificationRow[], now: readonly NotificationRow[]): Partial<Record<StoppableNotificationKey, boolean>> {
  const changes: Partial<Record<StoppableNotificationKey, boolean>> = {};
  for (const row of now) {
    if (!isStoppable(row.key) || row.locked) continue;
    const before = saved.find((candidate) => candidate.key === row.key);
    if (before && before.enabled !== row.enabled) changes[row.key] = row.enabled;
  }
  return changes;
}

/**
 * Where 通知 is kept for this page: the preview (mock mode: on screen only), the experience DB
 * (保存 sends the changes), not here yet (準備中: the flag is off or the provider's OWNER is not in
 * the experience DB), or the experience DB could not be read.
 */
export type NotificationSource = "preview" | "live" | "preparing" | "error";

/** 設定 › 通知 for this person. */
export type NotificationPanelView =
  /** Anyone but the owner: the settings are the owner's only. */
  | { kind: "owner-only"; text: string; preparing: boolean }
  | { kind: "error"; text: string; preparing: false }
  | {
      kind: "owner";
      /** Nothing can be changed here yet (準備中). */
      preparing: boolean;
      /** The verified addresses the notifications go to, shown as they are (changed outside this screen). */
      addresses: readonly string[];
      addressText: string;
      rows: NotificationRow[];
    };

/** 通知 as the settings page opens it: the owner changes it in the preview and once the experience DB keeps it. */
export function notificationPanelView(settings: HostNotificationSettings | null, role: HostProviderRole | null, source: NotificationSource): NotificationPanelView {
  const preparing = source === "preparing";
  if (role !== "OWNER" || !settings) return { kind: "owner-only", text: NOTIFICATION_OWNER_ONLY_TEXT, preparing };
  if (source === "error") return { kind: "error", text: NOTIFICATION_LOAD_FAILED_TEXT, preparing: false };
  const addresses = settings.email.addresses.filter((address) => address.trim() !== "");
  const addressText =
    addresses.length === 0 ? "NIHO からの通知は、NIHO アカウントの確認済みのメールに届きます" : addresses.length === 1 ? "NIHO からの通知はこのメールに届きます" : "NIHO からの通知はこれらのメールに届きます";
  return { kind: "owner", preparing, addresses, addressText, rows: notificationRows(settings.items) };
}

/** The changes a browser sent to 保存, or null unless they are one or more stoppable keys with booleans. */
export function notificationChangesInput(value: unknown): Partial<Record<StoppableNotificationKey, boolean>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > STOPPABLE_NOTIFICATION_KEYS.length) return null;
  const changes: Partial<Record<StoppableNotificationKey, boolean>> = {};
  for (const [key, enabled] of entries) {
    if (!(STOPPABLE_NOTIFICATION_KEYS as readonly string[]).includes(key) || typeof enabled !== "boolean") return null;
    changes[key as StoppableNotificationKey] = enabled;
  }
  return changes;
}
