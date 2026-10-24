import { MOCK_KITCHEN_BOOKINGS } from "@/host/mock/bookings";
import type { HostBooking } from "@/host/types";
import { supportSnapshot } from "@/support/types";
import type { AdminBooking, AdminHost, AdminNotification } from "./types";

export const MOCK_ADMIN_TODAY = "2026-10-21";
export const MOCK_ADMIN_NOW = "2026-10-21T15:30";

export const MOCK_ADMIN_HOSTS: readonly AdminHost[] = [
  { id: "sample-provider-kitchen", name: "サンプルの台所", supportEnabled: true },
  { id: "sample-provider-studio", name: "サンプル工房", supportEnabled: false },
  { id: "sample-provider-garden", name: "鎌倉の庭しごと", supportEnabled: true },
];

function source(id: string): HostBooking {
  const booking = MOCK_KITCHEN_BOOKINGS.find((candidate) => candidate.id === id);
  if (!booking) throw new Error(`Missing synthetic booking: ${id}`);
  return booking;
}

function adminBooking(base: HostBooking, fields: Omit<AdminBooking, keyof HostBooking>): AdminBooking {
  return { ...base, ...fields };
}

export const MOCK_ADMIN_BOOKINGS: readonly AdminBooking[] = [
  adminBooking(source("bk-2041"), {
    bookingNumber: "EX-202610-2041",
    hostId: "sample-provider-kitchen",
    hostName: "サンプルの台所",
    experienceTitle: "鎌倉の台所で囲む夕食",
    support: supportSnapshot(true, "2026-10-20T14:02"),
    needsAttention: true,
    attentionReason: "承認期限が近づいています",
    consultation: "英語での事前連絡と、当日の料理補助について相談しています。",
    assignee: "NIHO サポート 佐藤",
    adminNotes: "補助担当の人件費は、条件確定後にホストから担当者へ直接支払う。",
    hostContact: "ホストの連絡スレッド",
    guestContact: "予約者の連絡スレッド",
    adminHistory: [{ at: "2026-10-20T14:10", actorId: "admin-sato", actorName: "NIHO サポート 佐藤", action: "assigned", detail: "相談を受け付け、担当になりました" }],
  }),
  adminBooking(source("bk-2038"), {
    bookingNumber: "EX-202610-2038",
    hostId: "sample-provider-kitchen",
    hostName: "サンプルの台所",
    experienceTitle: "鎌倉の台所で囲む夕食",
    support: supportSnapshot(false, "2026-10-18T09:41"),
    needsAttention: false,
    attentionReason: "",
    consultation: "",
    assignee: null,
    adminNotes: "現在のホスト設定はONだが、この予約は受付時のOFF条件を保持。",
    hostContact: "ホストの連絡スレッド",
    guestContact: "予約者の連絡スレッド",
    adminHistory: [],
  }),
  adminBooking(source("bk-2033"), {
    bookingNumber: "EX-202610-2033",
    hostId: "sample-provider-kitchen",
    hostName: "サンプルの台所",
    experienceTitle: "鎌倉の台所で囲むティータイム",
    support: supportSnapshot(true, "2026-10-16T19:40"),
    needsAttention: true,
    attentionReason: "旅行者から取消依頼があります",
    consultation: "取消と全額返金の連絡代行を希望しています。",
    assignee: "NIHO サポート 田中",
    adminNotes: "旅行者都合のため全額返金。自由文を送る前にホストと確認する。",
    hostContact: "ホストの連絡スレッド",
    guestContact: "予約者の連絡スレッド",
    adminHistory: [{ at: "2026-10-20T08:20", actorId: "admin-tanaka", actorName: "NIHO サポート 田中", action: "assigned", detail: "取消依頼を確認しました" }],
  }),
  adminBooking({ ...source("bk-2044"), id: "bk-studio-101", guest: "Amelia Jones", date: "2026-10-28", amountYen: 42000, adults: 2, children: 0, guests: 2 }, {
    bookingNumber: "EX-202610-2101",
    hostId: "sample-provider-studio",
    hostName: "サンプル工房",
    experienceTitle: "草木染めの小さな布づくり",
    support: supportSnapshot(false, "2026-10-21T09:15"),
    needsAttention: true,
    attentionReason: "承認期限が近づいています",
    consultation: "",
    assignee: null,
    adminNotes: "運営上の確認対象。通常の代行操作は行わない。",
    hostContact: "ホストの連絡スレッド",
    guestContact: "予約者の連絡スレッド",
    adminHistory: [],
  }),
  adminBooking({ ...source("bk-2031"), id: "bk-garden-301", guest: "Maya Patel", date: "2026-11-02", amountYen: 18000, adultPriceYen: 18000, adults: 1, guests: 1 }, {
    bookingNumber: "EX-202611-2301",
    hostId: "sample-provider-garden",
    hostName: "鎌倉の庭しごと",
    experienceTitle: "庭の手入れと季節のお茶",
    support: supportSnapshot(true, "2026-10-19T11:20"),
    needsAttention: false,
    attentionReason: "",
    consultation: "当日に参加できる地元の方を2名ほど紹介してほしい。",
    assignee: "NIHO サポート 佐藤",
    adminNotes: "参加者への謝礼条件はホストと候補者が直接合意する。",
    hostContact: "ホストの連絡スレッド",
    guestContact: "予約者の連絡スレッド",
    adminHistory: [{ at: "2026-10-19T12:05", actorId: "admin-sato", actorName: "NIHO サポート 佐藤", action: "assigned", detail: "地元参加者の相談を受け付けました" }],
  }),
];

/**
 * Explicit synthetic receipts for support-ON bookings. These describe the five preview
 * event classes without pretending that an external delivery or real activity occurred.
 */
export const MOCK_ADMIN_NOTIFICATIONS: readonly AdminNotification[] = [
  {
    id: "notice-new-booking-2041",
    bookingId: "bk-2041",
    bookingNumber: "EX-202610-2041",
    kind: "new_booking",
    title: "新しい申込を受け付けました",
    detail: "サポートONの予約です。受付条件と承認期限を確認してください。",
    occurredAt: "2026-10-20T14:02",
    readAt: null,
  },
  {
    id: "notice-change-2041",
    bookingId: "bk-2041",
    bookingNumber: "EX-202610-2041",
    kind: "booking_changed",
    title: "申込内容が変更されました",
    detail: "人数に変更があります。予約の最新内容を確認してください。",
    occurredAt: "2026-10-21T09:10",
    readAt: null,
  },
  {
    id: "notice-cancel-2033",
    bookingId: "bk-2033",
    bookingNumber: "EX-202610-2033",
    kind: "cancellation",
    title: "取消の確認が必要です",
    detail: "取消依頼を受け付けました。ホストとの相談内容を確認してください。",
    occurredAt: "2026-10-20T08:20",
    readAt: null,
  },
  {
    id: "notice-refund-2033",
    bookingId: "bk-2033",
    bookingNumber: "EX-202610-2033",
    kind: "refund_attention",
    title: "返金内容を確認してください",
    detail: "返金の確認待ちです。ここでは実際の返金処理は行いません。",
    occurredAt: "2026-10-20T08:25",
    readAt: null,
  },
  {
    id: "notice-contact-garden-301",
    bookingId: "bk-garden-301",
    bookingNumber: "EX-202611-2301",
    kind: "new_contact",
    title: "新しい連絡があります",
    detail: "サポート相談に新しい連絡が届きました。予約詳細で確認してください。",
    occurredAt: "2026-10-21T13:45",
    readAt: null,
  },
];

export function mockAdminBooking(id: string): AdminBooking | null {
  return MOCK_ADMIN_BOOKINGS.find((booking) => booking.id === id) ?? null;
}

