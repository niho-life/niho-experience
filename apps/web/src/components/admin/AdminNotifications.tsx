"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { decodeAdminNotificationResponse, type AdminNotificationResponse } from "@/admin/notifications";
import type { AdminNotification } from "@/admin/types";
import { shortDateTime } from "@/host/bookings";
import { HOST_SURFACE } from "@/components/host/host-ui";

const kindLabel: Record<AdminNotification["kind"], string> = {
  new_booking: "新規申込",
  booking_changed: "申込変更",
  cancellation: "取消",
  refund_attention: "返金確認",
  new_contact: "新しい連絡",
};

async function fetchNotifications(): Promise<AdminNotificationResponse> {
  const response = await fetch("/admin/api/preview-notifications", { cache: "no-store" });
  const result: unknown = await response.json();
  const decoded = decodeAdminNotificationResponse(result);
  if (!response.ok || !decoded) throw new Error("notification load failed");
  return decoded;
}

export function AdminNotifications() {
  const router = useRouter();
  const [data, setData] = useState<AdminNotificationResponse | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busyIds, setBusyIds] = useState<readonly string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setData(await fetchNotifications());
    } catch {
      setLoadError("通知を読み込めませんでした。通信の状態を確認して、もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchNotifications().then(
      (result) => { if (active) setData(result); },
      () => { if (active) setLoadError("通知を読み込めませんでした。通信の状態を確認して、もう一度お試しください。"); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => data?.notifications.filter((notification) => filter === "all" || !notification.readAt) ?? [], [data, filter]);
  const markRead = async (notificationIds: readonly string[]) => {
    if (!notificationIds.length || busyIds.length) return;
    setBusyIds(notificationIds);
    setMutationError("");
    try {
      const response = await fetch("/admin/api/preview-notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationIds }),
      });
      const result: unknown = await response.json();
      const decoded = decodeAdminNotificationResponse(result);
      if (!response.ok || !decoded) throw new Error("notification update failed");
      setData(decoded);
      router.refresh();
    } catch {
      setMutationError("既読にできませんでした。表示は更新していません。もう一度お試しください。");
    } finally {
      setBusyIds([]);
    }
  };
  const unreadIds = data?.notifications.filter((notification) => !notification.readAt).map((notification) => notification.id) ?? [];

  return <div className="mx-auto w-full max-w-4xl px-4 py-5 md:px-7 md:py-7">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h1 className="font-display text-[1.5rem] font-medium md:text-[1.75rem]">通知</h1><p className="mt-1 text-[0.8125rem] text-muted">サポートONで受け付けた予約の新着を確認できます。</p></div>
      <span className="shrink-0 rounded-full bg-sand px-3 py-1 text-xs font-extrabold">合成プレビュー</span>
    </div>
    <section aria-label="通知一覧" aria-busy={loading} className={`${HOST_SURFACE} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div role="group" aria-label="通知の絞り込み" className="flex gap-1 rounded-full bg-sand/70 p-1">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className={`min-h-9 rounded-full px-3 font-extrabold ${filter === "all" ? "bg-canvas" : ""}`}>すべて</button>
          <button type="button" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")} className={`min-h-9 rounded-full px-3 font-extrabold ${filter === "unread" ? "bg-canvas" : ""}`}>未読{data ? ` ${data.unreadCount}件` : ""}</button>
        </div>
        <button type="button" disabled={!unreadIds.length || busyIds.length > 0} onClick={() => void markRead(unreadIds)} className="min-h-9 rounded-full border border-line-strong px-3 font-extrabold enabled:hover:bg-sand disabled:cursor-not-allowed disabled:opacity-50">すべて既読にする</button>
      </div>
      {mutationError ? <p role="alert" className="border-b border-danger/20 bg-danger-pale px-4 py-3 font-bold text-danger">{mutationError}</p> : null}
      {loading && !data ? <div role="status" className="px-4 py-12 text-center text-muted">通知を読み込んでいます…</div> : null}
      {!loading && loadError ? <div role="alert" className="px-4 py-10 text-center"><p className="font-bold text-danger">{loadError}</p><button type="button" onClick={() => void load()} className="mt-4 min-h-10 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand">もう一度試す</button></div> : null}
      {!loading && !loadError && data && visible.length === 0 ? <p className="px-4 py-12 text-center text-muted">{filter === "unread" ? "未読の通知はありません。" : "通知はありません。"}</p> : null}
      {!loadError && visible.length > 0 ? <ul>{visible.map((notification) => {
        const marking = busyIds.includes(notification.id);
        return <li key={notification.id} className={`border-t border-line first:border-t-0 ${notification.readAt ? "bg-sand/25" : ""}`}>
          <article className="grid min-w-0 gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-leaf-pale px-2 py-0.5 text-[0.6875rem] font-extrabold text-moss">{kindLabel[notification.kind]}</span>{notification.readAt ? <span className="text-xs text-muted">既読</span> : <span className="text-xs font-extrabold text-warn">未読</span>}<time className="text-xs text-muted">{shortDateTime(notification.occurredAt)}</time></div>
              <h2 className="mt-1 font-sans font-extrabold tracking-normal">{notification.title}</h2>
              <p className="mt-1 text-[0.8125rem] text-ink-soft">{notification.detail}</p>
              <p className="mt-1 text-xs text-muted">予約番号 {notification.bookingNumber}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {!notification.readAt ? <button type="button" disabled={busyIds.length > 0} onClick={() => void markRead([notification.id])} className="min-h-9 rounded-full border border-line-strong px-3 font-extrabold enabled:hover:bg-sand disabled:cursor-not-allowed disabled:opacity-50">{marking ? "更新中…" : "既読にする"}</button> : null}
              <Link href={`/admin/bookings?booking=${encodeURIComponent(notification.bookingId)}`} className="inline-flex min-h-9 items-center rounded-full bg-leaf px-3 font-extrabold hover:bg-leaf-hover">予約を見る</Link>
            </div>
          </article>
        </li>;
      })}</ul> : null}
    </section>
    <p className="mt-3 text-xs text-muted">通知を既読にしても、予約の状態や「要対応」は変わりません。</p>
  </div>;
}
