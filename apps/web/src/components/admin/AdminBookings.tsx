"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { filterAdminBookings, type AdminBookingFilters, type AdminOperation } from "@/admin/bookings";
import type { AdminBooking, AdminHost } from "@/admin/types";
import { bookingStatusLabel } from "@/host/bookings";
import { dateWithWeekdayJa, yen } from "@/host/format";
import { SELECT } from "@/components/host/fields";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { StatusPill } from "@/components/host/ui";
import { AdminBookingDetail } from "./AdminBookingDetail";

const EMPTY: AdminBookingFilters = { hostId: "", from: "", to: "", status: "", support: "", attention: "", search: "" };

export function AdminBookings({ initialBookings, hosts, today }: { initialBookings: readonly AdminBooking[]; hosts: readonly AdminHost[]; today: string }) {
  const params = useSearchParams();
  const [bookings, setBookings] = useState(initialBookings);
  const [filters, setFilters] = useState(EMPTY);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = Object.entries(filters).filter(([key, value]) => key !== "search" && value !== "").length;
  const selectedId = params.get("booking");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const filtered = useMemo(() => filterAdminBookings(bookings, filters), [bookings, filters]);
  const selected = bookings.find((booking) => booking.id === selectedId) ?? (selectedId ? null : filtered[0] ?? null);
  const sub = selectedId !== null;
  const edit = <K extends keyof AdminBookingFilters>(key: K, value: AdminBookingFilters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const open = (id: string) => { setNotice(""); window.history.pushState(null, "", `/admin/bookings?booking=${encodeURIComponent(id)}`); };
  const close = () => { setNotice(""); window.history.pushState(null, "", "/admin/bookings"); };
  const operate = async (operation: AdminOperation) => {
    if (!selected || busy) return false;
    const targetId = selected.id;
    const targetSelection = selectedId;
    const stillViewingTarget = () => new URL(window.location.href).searchParams.get("booking") === targetSelection;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/admin/api/preview-action", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ bookingId: targetId, operation }) });
      const result = await response.json() as { booking?: AdminBooking; message?: string; error?: string };
      if (!response.ok || !result.booking) {
        if (stillViewingTarget()) setNotice(result.message ?? "操作できませんでした。状態を確認してください。");
        return false;
      }
      setBookings((current) => current.map((booking) => booking.id === result.booking!.id ? result.booking! : booking));
      if (!stillViewingTarget()) return false;
      setNotice(result.message ?? "対応履歴を更新しました。");
      return true;
    } catch {
      if (stillViewingTarget()) setNotice("接続できませんでした。もう一度お試しください。");
      return false;
    }
    finally { setBusy(false); }
  };

  return <div className="mx-auto w-full max-w-[1400px] px-4 py-5 md:px-7 md:py-7">
    <div className={`mb-4 flex items-center justify-between gap-3 ${sub ? "max-lg:hidden" : ""}`}><div className="min-w-0"><h1 className="font-display text-[1.5rem] font-medium md:text-[1.75rem]">予約支援</h1><p className="mt-1 text-[0.8125rem] text-muted">全ホストの申込を確認し、サポートONの予約だけを代行できます。</p></div><span className="shrink-0 self-start whitespace-nowrap rounded-full bg-sand px-3 py-1 text-xs font-extrabold">プレビュー</span></div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_430px]">
      <div className={`min-w-0 ${sub ? "max-lg:hidden" : ""}`}>
        <section aria-label="予約の絞り込み" className={`${HOST_SURFACE} mb-3 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4`}>
          <label className="text-xs font-extrabold text-ink-soft sm:col-span-2">予約番号・予約者を検索<input type="search" value={filters.search} onChange={(e) => edit("search", e.currentTarget.value)} placeholder="EX-202610-2041 / Lucas" className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal text-ink md:text-sm" /></label>
          <button type="button" aria-expanded={filtersOpen} aria-controls="admin-booking-filters" onClick={() => setFiltersOpen((open) => !open)} className="min-h-8 text-left text-xs font-extrabold text-ink-soft sm:col-span-2 lg:hidden">詳細条件{activeFilters ? `（${activeFilters}）` : ""} {filtersOpen ? "−" : "+"}</button>
          <div id="admin-booking-filters" className={`${filtersOpen ? "grid" : "hidden"} min-w-0 gap-3 sm:col-span-2 sm:grid-cols-2 lg:contents`}>
          <label className="text-xs font-extrabold text-ink-soft">ホスト<select aria-label="ホスト" value={filters.hostId} onChange={(e) => edit("hostId", e.currentTarget.value)} className={`${SELECT} mt-1 w-full`}><option value="">すべて</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
          <label className="text-xs font-extrabold text-ink-soft">状態<select aria-label="状態" value={filters.status} onChange={(e) => edit("status", e.currentTarget.value as AdminBookingFilters["status"])} className={`${SELECT} mt-1 w-full`}><option value="">すべて</option><option value="pending">承認待ち</option><option value="confirmed">確定</option><option value="refund_needed">要返金</option><option value="cancelled">取消済み</option><option value="declined">辞退</option><option value="expired">期限切れ</option></select></label>
          <label className="text-xs font-extrabold text-ink-soft">開始日<input aria-label="開始日" type="date" value={filters.from} onChange={(e) => edit("from", e.currentTarget.value)} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal text-ink md:text-sm" /></label>
          <label className="text-xs font-extrabold text-ink-soft">終了日<input aria-label="終了日" type="date" value={filters.to} onChange={(e) => edit("to", e.currentTarget.value)} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal text-ink md:text-sm" /></label>
          <label className="text-xs font-extrabold text-ink-soft">サポート<select aria-label="サポート" value={filters.support} onChange={(e) => edit("support", e.currentTarget.value as AdminBookingFilters["support"])} className={`${SELECT} mt-1 w-full`}><option value="">すべて</option><option value="on">ON</option><option value="off">OFF</option></select></label>
          <label className="text-xs font-extrabold text-ink-soft">要対応<select aria-label="要対応" value={filters.attention} onChange={(e) => edit("attention", e.currentTarget.value as AdminBookingFilters["attention"])} className={`${SELECT} mt-1 w-full`}><option value="">すべて</option><option value="yes">要対応</option><option value="no">対応不要</option></select></label>
          </div>
        </section>
        <section aria-label="予約一覧" className={`${HOST_SURFACE} overflow-hidden`}><div className="flex items-center justify-between border-b border-line px-4 py-2.5"><h2 className="font-sans text-xs font-extrabold tracking-normal text-ink-soft">申込一覧</h2><span className="text-xs text-muted">{filtered.length}件</span></div>{filtered.length ? <ul>{filtered.map((booking) => <li key={booking.id} className="border-t border-line first:border-t-0"><button type="button" onClick={() => open(booking.id)} className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 px-4 py-3 text-left hover:bg-sand/70 focus-visible:outline-offset-[-3px] ${selected?.id === booking.id ? "lg:bg-sand" : ""}`}><span className="min-w-0"><span className="flex flex-wrap items-center gap-x-2"><strong className="[overflow-wrap:anywhere]">{booking.guest}</strong><span className="text-xs text-muted">{booking.bookingNumber}</span></span><span className="block truncate text-[0.78125rem] text-muted">{booking.hostName} · {dateWithWeekdayJa(booking.date)}{booking.start} · {yen(booking.amountYen)}</span><span className="mt-1 flex flex-wrap gap-1.5"><span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-extrabold ${booking.support.enabled ? "bg-leaf-pale text-moss" : "bg-sand text-ink-soft"}`}>支援{booking.support.enabled ? "ON" : "OFF"}</span>{booking.needsAttention ? <span className="rounded-full bg-warn-pale px-2 py-0.5 text-[0.6875rem] font-extrabold text-warn">要対応</span> : null}</span></span><StatusPill status={bookingStatusLabel(booking, today)} /></button></li>)}</ul> : <p className="px-4 py-8 text-center text-muted">条件に合う予約はありません。</p>}</section>
      </div>
      <div className={`min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto ${sub ? "" : "max-lg:hidden"}`}>{sub ? <button type="button" onClick={close} className="mb-3 inline-flex min-h-8 items-center font-extrabold lg:hidden">‹ 予約支援へ戻る</button> : null}{selected ? <AdminBookingDetail key={selected.id} booking={selected} today={today} notice={notice} busy={busy} onOperation={operate} /> : <section className={`${HOST_SURFACE} p-5`}><h2 className="font-sans font-extrabold tracking-normal">予約が見つかりません</h2><button type="button" onClick={close} className="mt-2 font-extrabold underline">一覧へ戻る</button></section>}</div>
    </div>
  </div>;
}

