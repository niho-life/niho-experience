"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ExperienceAdminBookingDetailResponse, ExperienceAdminBookingListItem, ExperienceAdminBookingListResponse } from "@niho-experience/api-client/admin-read";
import { decodeExperienceAdminBookingDetailResponse, decodeExperienceAdminBookingListResponse } from "@niho-experience/api-client/admin-read-schema";
import { adminBookingQuery, adminHttpBookingStatus, adminHttpSupportLabel, EMPTY_ADMIN_HTTP_BOOKING_FILTERS, mergeUniqueBookings, type AdminHttpBookingFilters } from "@/admin/http-view";
import { adminDateTime } from "@/admin/date-time";
import { yen } from "@/host/format";
import { SELECT } from "@/components/host/fields";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { StatusPill } from "@/components/host/ui";
import { AdminHttpBookingDetail } from "./AdminHttpBookingDetail";
import { useAdminGuardedNavigation, useAdminLeaveGuardReset } from "./AdminLeaveGuard";

async function requestBookings(filters: AdminHttpBookingFilters, cursor: string | undefined, signal: AbortSignal): Promise<ExperienceAdminBookingListResponse> {
  const response = await fetch("/admin/api/bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(adminBookingQuery(filters, cursor)),
    cache: "no-store",
    signal,
  });
  if (response.status === 401) throw new Error("session");
  const decoded = decodeExperienceAdminBookingListResponse(await response.json() as unknown);
  if (!response.ok || !decoded) throw new Error("load");
  return decoded;
}

async function requestBookingDetail(id: string, signal: AbortSignal): Promise<ExperienceAdminBookingDetailResponse | "not-found"> {
  const response = await fetch(`/admin/api/bookings/${encodeURIComponent(id)}`, { cache: "no-store", signal });
  if (response.status === 401) throw new Error("session");
  if (response.status === 404) return "not-found";
  const decoded = decodeExperienceAdminBookingDetailResponse(await response.json() as unknown);
  if (!response.ok || !decoded) throw new Error("load");
  return decoded;
}

function BookingRow({ booking, selected, onOpen }: { booking: ExperienceAdminBookingListItem; selected: boolean; onOpen: () => void }) {
  const support = adminHttpSupportLabel(booking.support);
  return <button type="button" onClick={onOpen} className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 px-4 py-3 text-left hover:bg-sand/70 focus-visible:outline-offset-[-3px] ${selected ? "lg:bg-sand" : ""}`}>
    <span className="min-w-0"><span className="flex flex-wrap items-center gap-x-2"><strong className="[overflow-wrap:anywhere]">{booking.guestName || "予約者名は保持されていません"}</strong><span className="text-xs text-muted">{booking.id}</span></span><span className="block truncate text-[0.78125rem] text-muted">{booking.host.displayName} · {adminDateTime(booking.startAt)} · {yen(booking.totalYen)}</span><span className="mt-1 flex flex-wrap gap-1.5"><span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-extrabold ${support.className}`}>{support.label}</span><span className="rounded-full bg-sand px-2 py-0.5 text-[0.6875rem] font-extrabold text-ink-soft">{booking.host.kind === "SPOT" ? "拠点" : "外部提供者"}</span>{booking.needsAttention ? <span className="rounded-full bg-warn-pale px-2 py-0.5 text-[0.6875rem] font-extrabold text-warn">要対応</span> : null}</span></span>
    <StatusPill status={adminHttpBookingStatus(booking.status)} />
  </button>;
}

export function AdminHttpBookings({ supportCaseEnabled = false, operationsEnabled = false, feeSummaryEnabled = false }: { supportCaseEnabled?: boolean; operationsEnabled?: boolean; feeSummaryEnabled?: boolean }) {
  const router = useRouter();
  const guardedNavigate = useAdminGuardedNavigation();
  const resetLeaveGuard = useAdminLeaveGuardReset();
  const params = useSearchParams();
  const selectedId = params.get("booking");
  const [filters, setFilters] = useState(EMPTY_ADMIN_HTTP_BOOKING_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [bookings, setBookings] = useState<readonly ExperienceAdminBookingListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadErrorScope, setLoadErrorScope] = useState<"first" | "more" | null>(null);
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [detail, setDetail] = useState<ExperienceAdminBookingDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error" | "not-found">("idle");
  const [detailRetry, setDetailRetry] = useState(0);
  const [expired, setExpired] = useState(false);
  const listSequence = useRef(0);
  const loadMoreSequence = useRef(0);
  const detailSequence = useRef(0);
  const activeFilters = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);
  const queryKey = useMemo(() => JSON.stringify(adminBookingQuery(filters)), [filters]);
  const sub = selectedId !== null;

  const expireSession = useCallback(() => {
    resetLeaveGuard();
    ++listSequence.current;
    ++loadMoreSequence.current;
    ++detailSequence.current;
    setBookings([]);
    setNextCursor(null);
    setLoaded(false);
    setLoadedQueryKey(null);
    setLoading(false);
    setLoadingMore(false);
    setDetail(null);
    setDetailState("idle");
    setFilters({ ...EMPTY_ADMIN_HTTP_BOOKING_FILTERS });
    setFiltersOpen(false);
    setLoadErrorScope("first");
    setLoadError("管理者接続を確認できません。もう一度サインインしてください。");
    setExpired(true);
    router.refresh();
  }, [resetLeaveGuard, router]);

  useEffect(() => {
    if (expired) return;
    const sequence = ++listSequence.current;
    ++loadMoreSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadingMore(false);
      setLoadError("");
      setLoadErrorScope(null);
      setNextCursor(null);
      setLoadedQueryKey(null);
      void requestBookings(filters, undefined, controller.signal).then((result) => {
        if (sequence !== listSequence.current) return;
        setBookings(result.bookings);
        setNextCursor(result.nextCursor);
        setLoadedQueryKey(queryKey);
        setLoaded(true);
      }).catch((error: unknown) => {
        if (sequence !== listSequence.current || controller.signal.aborted) return;
        if (error instanceof Error && error.message === "session") {
          expireSession();
          return;
        }
        setLoadErrorScope("first");
        setLoadError("予約を読み込めませんでした。表示中の結果は更新していません。");
      }).finally(() => { if (sequence === listSequence.current) setLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [expireSession, expired, filters, listRetry, queryKey]);

  useEffect(() => {
    if (expired) return;
    const sequence = ++detailSequence.current;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      if (!selectedId) { setDetail(null); setDetailState("idle"); return; }
      setDetail((current) => current?.booking.id === selectedId ? current : null);
      setDetailState("loading");
      try {
        const result = await requestBookingDetail(selectedId, controller.signal);
        if (sequence !== detailSequence.current) return;
        if (result === "not-found") { setDetail(null); setDetailState("not-found"); }
        else { setDetail(result); setDetailState("idle"); }
      } catch (error) {
        if (sequence !== detailSequence.current || controller.signal.aborted) return;
        if (error instanceof Error && error.message === "session") expireSession();
        else setDetailState("error");
      }
    });
    return () => controller.abort();
  }, [selectedId, detailRetry, expireSession, expired]);

  const invalidateList = () => {
    ++listSequence.current;
    ++loadMoreSequence.current;
    setLoading(true);
    setLoadingMore(false);
    setLoadError("");
    setLoadErrorScope(null);
    setNextCursor(null);
    setLoadedQueryKey(null);
  };
  const edit = <K extends keyof AdminHttpBookingFilters>(key: K, value: AdminHttpBookingFilters[K]) => {
    invalidateList();
    setFilters((current) => ({ ...current, [key]: value }));
  };
  const clearFilters = () => {
    invalidateList();
    setFilters({ ...EMPTY_ADMIN_HTTP_BOOKING_FILTERS });
  };
  const retryFirstPage = () => {
    invalidateList();
    setListRetry((value) => value + 1);
  };
  const open = (id: string) => guardedNavigate(() => router.push(`/admin/bookings?booking=${encodeURIComponent(id)}`, { scroll: false }));
  const close = () => guardedNavigate(() => router.push("/admin/bookings", { scroll: false }));
  const loadMore = async () => {
    if (!nextCursor || loadingMore || loading || loadedQueryKey !== queryKey) return;
    const sequence = listSequence.current;
    const operation = ++loadMoreSequence.current;
    const cursor = nextCursor;
    const controller = new AbortController();
    setLoadingMore(true); setLoadError(""); setLoadErrorScope(null);
    try {
      const result = await requestBookings(filters, cursor, controller.signal);
      if (sequence !== listSequence.current || operation !== loadMoreSequence.current) return;
      setBookings((current) => mergeUniqueBookings(current, result.bookings));
      setNextCursor(result.nextCursor);
    } catch (error) {
      if (sequence === listSequence.current && operation === loadMoreSequence.current) {
        if (error instanceof Error && error.message === "session") {
          expireSession();
          return;
        }
        setLoadErrorScope("more");
        setLoadError("次のページを読み込めませんでした。読み込み済みの予約はそのまま表示しています。");
      }
    } finally {
      if (operation === loadMoreSequence.current) setLoadingMore(false);
    }
  };

  if (expired) return <div className="mx-auto w-full max-w-[1400px] px-4 py-5 md:px-7 md:py-7"><section role="alert" className={`${HOST_SURFACE} mx-auto max-w-2xl p-6`}><h1 className="font-display text-2xl font-medium">管理者接続の有効期限が切れました</h1><p className="mt-2 text-ink-soft">予約一覧・詳細・検索条件・担当候補・入力中の内部メモをこの画面から消去しました。</p><Link href="/admin" className="mt-5 inline-flex min-h-11 items-center rounded-full bg-leaf px-5 font-extrabold hover:bg-leaf-hover">もう一度サインイン</Link></section></div>;

  return <div className="mx-auto w-full max-w-[1400px] px-4 py-5 md:px-7 md:py-7">
    <div className={`mb-4 flex items-center justify-between gap-3 ${sub ? "max-lg:hidden" : ""}`}><div className="min-w-0"><h1 className="font-display text-[1.5rem] font-medium md:text-[1.75rem]">予約支援</h1><p className="mt-1 text-[0.8125rem] text-muted">{supportCaseEnabled ? "NIHOの予約を確認し、事務局内の担当とメモを管理します。" : "NIHOの予約を横断検索して確認します。現在は内容の確認だけができます。"}</p></div><span className="shrink-0 self-start whitespace-nowrap rounded-full bg-leaf-pale px-3 py-1 text-xs font-extrabold text-moss">NIHO参照</span></div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_430px]">
      <div className={`min-w-0 ${sub ? "max-lg:hidden" : ""}`}>
        <section aria-label="予約の絞り込み" className={`${HOST_SURFACE} mb-3 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4`}>
          <label className="text-xs font-extrabold text-ink-soft sm:col-span-2">予約ID・予約者を検索<input type="search" value={filters.search} onChange={(event) => edit("search", event.currentTarget.value)} maxLength={200} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal text-ink md:text-sm" /></label>
          <label className="text-xs font-extrabold text-ink-soft sm:col-span-2">ホスト名を検索<input type="search" value={filters.hostSearch} onChange={(event) => edit("hostSearch", event.currentTarget.value)} maxLength={200} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal text-ink md:text-sm" /></label>
          <button type="button" aria-expanded={filtersOpen} aria-controls="admin-http-booking-filters" onClick={() => setFiltersOpen((openState) => !openState)} className="min-h-8 text-left text-xs font-extrabold text-ink-soft sm:col-span-2 lg:hidden">詳細条件{activeFilters ? `（${activeFilters}）` : ""} {filtersOpen ? "−" : "+"}</button>
          <div id="admin-http-booking-filters" className={`${filtersOpen ? "grid" : "hidden"} min-w-0 gap-3 sm:col-span-2 sm:grid-cols-2 lg:contents`}>
            <label className="text-xs font-extrabold text-ink-soft">状態<select aria-label="状態" value={filters.status} onChange={(event) => edit("status", event.currentTarget.value as AdminHttpBookingFilters["status"])} className={`${SELECT} mt-1 w-full`}><option value="">すべて</option><option value="PENDING">承認待ち</option><option value="PAYMENT_PENDING">支払待ち</option><option value="PROVISIONAL">仮受付</option><option value="CONFIRMED">確定</option><option value="REFUND_NEEDED">要返金</option><option value="CANCELLED">取消済み</option><option value="DECLINED">辞退</option><option value="EXPIRED">期限切れ</option></select></label>
            <label className="text-xs font-extrabold text-ink-soft">サポート<select aria-label="サポート" value={filters.support} onChange={(event) => edit("support", event.currentTarget.value as AdminHttpBookingFilters["support"])} className={`${SELECT} mt-1 w-full`}><option value="">すべて</option><option value="on">ON</option><option value="off">OFF</option><option value="legacy">旧予約・確認不能</option></select></label>
            <label className="text-xs font-extrabold text-ink-soft">開始日<input aria-label="開始日" type="date" value={filters.fromDate} onChange={(event) => edit("fromDate", event.currentTarget.value)} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal text-ink md:text-sm" /></label>
            <label className="text-xs font-extrabold text-ink-soft">終了日<input aria-label="終了日" type="date" value={filters.toDate} onChange={(event) => edit("toDate", event.currentTarget.value)} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal text-ink md:text-sm" /></label>
            <label className="text-xs font-extrabold text-ink-soft">要対応<select aria-label="要対応" value={filters.attention} onChange={(event) => edit("attention", event.currentTarget.value as AdminHttpBookingFilters["attention"])} className={`${SELECT} mt-1 w-full`}><option value="">すべて</option><option value="yes">要対応</option><option value="no">対応不要</option></select></label>
            <button type="button" onClick={clearFilters} className="min-h-10 self-end rounded-full border border-line-strong px-4 text-sm font-extrabold hover:bg-sand">条件をクリア</button>
          </div>
        </section>
        {loadError ? <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-danger-pale px-4 py-3 font-bold text-danger"><span>{loadError}</span><button type="button" onClick={loadErrorScope === "more" ? () => void loadMore() : retryFirstPage} className="min-h-9 rounded-full border border-danger/40 px-3">もう一度試す</button></div> : null}
        <section aria-label="予約一覧" aria-busy={loading || loadingMore} className={`${HOST_SURFACE} overflow-hidden`}><div className="flex items-center justify-between border-b border-line px-4 py-2.5"><h2 className="font-sans text-xs font-extrabold tracking-normal text-ink-soft">申込一覧</h2><span className="text-xs text-muted">{loaded ? `読み込み済み ${bookings.length}件` : "件数を確認中"}</span></div>
          {loading && !loaded ? <p role="status" className="px-4 py-10 text-center text-muted">予約を読み込んでいます…</p> : null}
          {loaded && bookings.length ? <ul>{bookings.map((booking) => <li key={booking.id} className="border-t border-line first:border-t-0"><BookingRow booking={booking} selected={selectedId === booking.id} onOpen={() => open(booking.id)} /></li>)}</ul> : null}
          {loaded && !loading && !loadError && bookings.length === 0 ? <p className="px-4 py-10 text-center text-muted">NIHOで条件に一致する予約はありません。</p> : null}
          {nextCursor && loadedQueryKey === queryKey ? <div className="border-t border-line p-3 text-center"><button type="button" disabled={loadingMore || loading} onClick={() => void loadMore()} className="min-h-10 rounded-full border border-line-strong px-5 font-extrabold enabled:hover:bg-sand disabled:opacity-50">{loadingMore ? "読み込み中…" : "次の50件を読み込む"}</button></div> : null}
        </section>
      </div>
      <div className={`min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto ${sub ? "" : "max-lg:hidden"}`}>
        {sub ? <button type="button" onClick={close} className="mb-3 inline-flex min-h-8 items-center font-extrabold lg:hidden">‹ 予約支援へ戻る</button> : null}
        {!selectedId ? <section className={`${HOST_SURFACE} p-5`}><h2 className="font-sans font-extrabold tracking-normal">予約を選択してください</h2><p className="mt-2 text-sm text-muted">一覧の予約を選ぶと、NIHOから詳細を読み込みます。</p></section> : null}
        {detailState === "loading" && detail?.booking.id !== selectedId ? <section className={`${HOST_SURFACE} p-5`} role="status">予約詳細を読み込んでいます…</section> : null}
        {detailState === "error" ? <section className={`${HOST_SURFACE} p-5`} role="alert"><h2 className="font-sans font-extrabold tracking-normal">予約詳細を読み込めませんでした</h2><button type="button" onClick={() => setDetailRetry((value) => value + 1)} className="mt-3 min-h-10 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand">もう一度試す</button></section> : null}
        {detailState === "not-found" ? <section className={`${HOST_SURFACE} p-5`}><h2 className="font-sans font-extrabold tracking-normal">予約が見つかりません</h2><p className="mt-2 text-sm text-muted">予約IDと現在の参照権限を確認してください。</p><button type="button" onClick={close} className="mt-3 font-extrabold underline">一覧へ戻る</button></section> : null}
        {detail?.booking.id === selectedId ? <AdminHttpBookingDetail response={detail} supportCaseEnabled={supportCaseEnabled} operationsEnabled={operationsEnabled} feeSummaryEnabled={feeSummaryEnabled} operationId={params.get("operation")} onSessionExpired={expireSession} /> : null}
      </div>
    </div>
  </div>;
}
