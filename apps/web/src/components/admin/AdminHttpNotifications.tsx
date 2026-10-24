"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExperienceAdminNotificationListResponse, ExperienceAdminNotificationReadResponse, ExperienceAdminNotificationType } from "@niho-experience/api-client/admin-read";
import { decodeExperienceAdminNotificationListResponse, decodeExperienceAdminNotificationReadResponse } from "@niho-experience/api-client/admin-read-schema";
import { adminDateTime } from "@/admin/date-time";
import { HOST_SURFACE } from "@/components/host/host-ui";

const typeLabel: Record<ExperienceAdminNotificationType, string> = {
  APPLICATION_RECEIVED: "新規申込",
  BOOKING_CONFIRMED: "予約確定",
  BOOKING_DECLINED: "辞退",
  BOOKING_EXPIRED: "期限切れ",
  BOOKING_CANCELLED: "取消",
  REFUND_NEEDED: "返金確認",
  TRAVELER_CANCEL_REQUESTED: "旅行者の取消申出",
};

async function requestNotifications(unread: boolean, cursor: string | undefined, signal?: AbortSignal): Promise<ExperienceAdminNotificationListResponse> {
  const params = new URLSearchParams({ unread: String(unread), limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/admin/api/notifications?${params}`, { cache: "no-store", signal });
  if (response.status === 401) throw new Error("session");
  const decoded = decodeExperienceAdminNotificationListResponse(await response.json() as unknown);
  if (!response.ok || !decoded) throw new Error("load");
  return decoded;
}

async function markNotificationsRead(notificationIds: readonly string[]): Promise<ExperienceAdminNotificationReadResponse> {
  const response = await fetch("/admin/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notificationIds }) });
  if (response.status === 401) throw new Error("session");
  const decoded = decodeExperienceAdminNotificationReadResponse(await response.json() as unknown);
  if (!response.ok || !decoded) throw new Error("update");
  const expected = [...notificationIds].sort();
  const actual = decoded.notifications.map((item) => item.id).sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]) || new Set(actual).size !== actual.length) throw new Error("partial");
  return decoded;
}

export function AdminHttpNotifications() {
  const router = useRouter();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [pages, setPages] = useState<readonly ExperienceAdminNotificationListResponse[]>([]);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadErrorScope, setLoadErrorScope] = useState<"first" | "more" | null>(null);
  const [loadedFilter, setLoadedFilter] = useState<"all" | "unread" | null>(null);
  const [mutationError, setMutationError] = useState("");
  const [busyIds, setBusyIds] = useState<readonly string[]>([]);
  const readSequence = useRef(0);
  const loadMoreSequence = useRef(0);
  const nextCursor = loadedFilter === filter ? pages.at(-1)?.nextCursor ?? null : null;
  const notifications = useMemo(() => pages.flatMap((page) => page.notifications), [pages]);

  const expireSession = useCallback(() => {
    ++readSequence.current;
    ++loadMoreSequence.current;
    setPages([]);
    setUnreadCount(null);
    setLoadedFilter(null);
    setLoading(false);
    setLoadingMore(false);
    setBusyIds([]);
    setMutationError("");
    setLoadErrorScope("first");
    setLoadError("管理者接続を確認できません。もう一度サインインしてください。");
    router.refresh();
  }, [router]);

  const loadFirst = useCallback(async (currentFilter: "all" | "unread") => {
    const requestSequence = ++readSequence.current;
    ++loadMoreSequence.current;
    const controller = new AbortController();
    await Promise.resolve();
    setLoading(true); setLoadingMore(false); setLoadError(""); setLoadErrorScope(null); setMutationError("");
    try {
      const response = await requestNotifications(currentFilter === "unread", undefined, controller.signal);
      if (requestSequence !== readSequence.current) return;
      setPages([response]);
      setUnreadCount(response.unreadCount);
      setLoadedFilter(currentFilter);
    } catch (error) {
      if (requestSequence !== readSequence.current) return;
      if (error instanceof Error && error.message === "session") {
        expireSession();
        return;
      }
      setLoadErrorScope("first");
      setLoadError("通知を読み込めませんでした。表示中の通知は更新していません。");
    } finally {
      if (requestSequence === readSequence.current) setLoading(false);
    }
  }, [expireSession]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadFirst(filter); }, 0);
    return () => window.clearTimeout(timer);
  }, [filter, loadFirst]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore || loading || busyIds.length || loadedFilter !== filter) return;
    const requestSequence = readSequence.current;
    const operation = ++loadMoreSequence.current;
    const cursor = nextCursor;
    setLoadingMore(true); setLoadError(""); setLoadErrorScope(null);
    try {
      const response = await requestNotifications(filter === "unread", cursor);
      if (requestSequence !== readSequence.current || operation !== loadMoreSequence.current) return;
      setPages((current) => [...current, response]);
      setUnreadCount(response.unreadCount);
    } catch (error) {
      if (requestSequence === readSequence.current && operation === loadMoreSequence.current) {
        if (error instanceof Error && error.message === "session") {
          expireSession();
          return;
        }
        setLoadErrorScope("more");
        setLoadError("次のページを読み込めませんでした。読み込み済みの通知はそのまま表示しています。");
      }
    } finally {
      if (operation === loadMoreSequence.current) setLoadingMore(false);
    }
  };

  const changeFilter = (nextFilter: "all" | "unread") => {
    if (nextFilter === filter) return;
    ++readSequence.current;
    ++loadMoreSequence.current;
    setLoading(true);
    setLoadingMore(false);
    setLoadedFilter(null);
    setLoadError("");
    setLoadErrorScope(null);
    setFilter(nextFilter);
  };

  const markRead = async (notificationIds: readonly string[]) => {
    if (!notificationIds.length || busyIds.length || loadedFilter !== filter) return;
    ++readSequence.current;
    ++loadMoreSequence.current;
    setLoading(false);
    setLoadingMore(false);
    setBusyIds(notificationIds); setMutationError("");
    try {
      const result = await markNotificationsRead(notificationIds);
      const readAt = new Map(result.notifications.map((item) => [item.id, item.readAt]));
      setPages((current) => current.map((page) => ({
        ...page,
        unreadCount: result.unreadCount,
        // Keep the API's keyset cursor when marking all items on this page read.
        notifications: page.notifications
          .map((item) => readAt.has(item.id) ? { ...item, readAt: readAt.get(item.id)! } : item)
          .filter((item) => filter !== "unread" || item.readAt === null),
      })));
      setUnreadCount(result.unreadCount);
      router.refresh();
    } catch (error) {
      if (error instanceof Error && error.message === "session") expireSession();
      else setMutationError("既読にできませんでした。通知と未読件数は更新していません。もう一度お試しください。");
    } finally {
      setBusyIds([]);
    }
  };

  return <div className="mx-auto w-full max-w-4xl px-4 py-5 md:px-7 md:py-7">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h1 className="font-display text-[1.5rem] font-medium md:text-[1.75rem]">通知</h1><p className="mt-1 text-[0.8125rem] text-muted">NIHOの支援対象予約の通知を手動で更新して確認します。</p></div><span className="shrink-0 rounded-full bg-leaf-pale px-3 py-1 text-xs font-extrabold text-moss">NIHO参照</span></div>
    <section aria-label="通知一覧" aria-busy={loading || loadingMore} className={`${HOST_SURFACE} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div role="group" aria-label="通知の絞り込み" className="flex gap-1 rounded-full bg-sand/70 p-1"><button type="button" disabled={busyIds.length > 0} aria-pressed={filter === "all"} onClick={() => changeFilter("all")} className={`min-h-9 rounded-full px-3 font-extrabold disabled:opacity-50 ${filter === "all" ? "bg-canvas" : ""}`}>すべて</button><button type="button" disabled={busyIds.length > 0} aria-pressed={filter === "unread"} onClick={() => changeFilter("unread")} className={`min-h-9 rounded-full px-3 font-extrabold disabled:opacity-50 ${filter === "unread" ? "bg-canvas" : ""}`}>未読{unreadCount === null ? " 件数不明" : ` ${unreadCount}件`}</button></div>
        <button type="button" disabled={loading || busyIds.length > 0} onClick={() => void loadFirst(filter)} className="min-h-9 rounded-full border border-line-strong px-3 font-extrabold enabled:hover:bg-sand disabled:opacity-50">{loading ? "更新中…" : "手動で更新"}</button>
      </div>
      {mutationError ? <p role="alert" className="border-b border-danger/20 bg-danger-pale px-4 py-3 font-bold text-danger">{mutationError}</p> : null}
      {loadError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-danger/20 bg-danger-pale px-4 py-3 font-bold text-danger"><span>{loadError}</span><button type="button" onClick={loadErrorScope === "more" ? () => void loadMore() : () => void loadFirst(filter)} className="min-h-9 rounded-full border border-danger/40 px-3">もう一度試す</button></div> : null}
      {loading && pages.length === 0 ? <div role="status" className="px-4 py-12 text-center text-muted">通知を読み込んでいます…</div> : null}
      {!loading && pages.length > 0 && notifications.length === 0 ? <p className="px-4 py-12 text-center text-muted">{filter === "unread" && (unreadCount ?? 0) > 0 ? "未読通知はありますが、このページには表示されませんでした。手動更新するか次のページを確認してください。" : filter === "unread" ? "現在、未読通知はありません。" : "通知はありません。"}</p> : null}
      {pages.map((page, pageIndex) => {
        const pageUnread = page.notifications.filter((item) => item.readAt === null).map((item) => item.id);
        return <section key={`${pageIndex}-${page.notifications[0]?.id ?? "empty"}`} aria-label={`通知ページ ${pageIndex + 1}`} className="border-t border-line first:border-t-0">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-sand/35 px-4 py-2"><span className="text-xs font-extrabold text-muted">読み込みページ {pageIndex + 1} · {page.notifications.length}件</span><button type="button" disabled={!pageUnread.length || busyIds.length > 0 || loadedFilter !== filter} onClick={() => void markRead(pageUnread)} className="min-h-8 rounded-full border border-line-strong px-3 text-xs font-extrabold enabled:hover:bg-sand disabled:cursor-not-allowed disabled:opacity-50">このページの未読{pageUnread.length}件を既読にする</button></div>
          {page.notifications.length ? <ul>{page.notifications.map((notification) => {
            const marking = busyIds.includes(notification.id);
            return <li key={notification.id} className={`border-t border-line ${notification.readAt ? "bg-sand/25" : ""}`}><article className="grid min-w-0 gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-leaf-pale px-2 py-0.5 text-[0.6875rem] font-extrabold text-moss">{typeLabel[notification.type]}</span>{notification.readAt ? <span className="text-xs text-muted">既読</span> : <span className="text-xs font-extrabold text-warn">未読</span>}<time className="text-xs text-muted">{adminDateTime(notification.occurredAt)}</time></div><h2 className="mt-1 font-sans font-extrabold tracking-normal">{notification.title}</h2><p className="mt-1 whitespace-pre-wrap text-[0.8125rem] text-ink-soft">{notification.body}</p><p className="mt-1 text-xs text-muted">予約ID {notification.bookingRequestId}</p></div><div className="flex flex-wrap items-center gap-2 sm:justify-end">{!notification.readAt ? <button type="button" disabled={busyIds.length > 0 || loadedFilter !== filter} onClick={() => void markRead([notification.id])} className="min-h-9 rounded-full border border-line-strong px-3 font-extrabold enabled:hover:bg-sand disabled:cursor-not-allowed disabled:opacity-50">{marking ? "更新中…" : "既読にする"}</button> : null}<Link href={`/admin/bookings?booking=${encodeURIComponent(notification.bookingRequestId)}`} className="inline-flex min-h-9 items-center rounded-full bg-leaf px-3 font-extrabold hover:bg-leaf-hover">予約を見る</Link></div></article></li>;
          })}</ul> : null}
        </section>;
      })}
      {nextCursor ? <div className="border-t border-line p-3 text-center"><button type="button" disabled={loadingMore || loading || busyIds.length > 0} onClick={() => void loadMore()} className="min-h-10 rounded-full border border-line-strong px-5 font-extrabold enabled:hover:bg-sand disabled:opacity-50">{loadingMore ? "読み込み中…" : "次の50件を読み込む"}</button></div> : null}
    </section>
    <p className="mt-3 text-xs text-muted">通知はリアルタイム配信ではありません。既読にしても予約の状態や「要対応」は変わりません。</p>
  </div>;
}
