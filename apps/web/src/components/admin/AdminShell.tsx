"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function AdminShell({ actorName, unreadCount = null, channelManager = false, siteBookings = false, children }: { actorName: string | null; unreadCount?: number | null; channelManager?: boolean; siteBookings?: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const bookingsCurrent = pathname.startsWith("/admin/bookings");
  const notificationsCurrent = pathname.startsWith("/admin/notifications");
  const preparationsCurrent = pathname.startsWith("/admin/preparations");
  const operatorsCurrent = pathname.startsWith("/admin/operators");
  const channelsCurrent = pathname.startsWith("/admin/channels");
  const siteBookingsCurrent = pathname.startsWith("/admin/site-bookings");
  const navClass = "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 font-extrabold hover:bg-sand";
  return (
    <div className="min-h-dvh bg-sand/45 text-[0.875rem] leading-[1.6]">
      <header className="border-b border-line bg-canvas">
        <div className="mx-auto grid w-full max-w-[1400px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-2 sm:flex sm:min-h-14 sm:gap-4 sm:py-0 md:px-7">
          <Link href="/admin/bookings" className="min-w-0 font-extrabold tracking-[0.04em]">NIHO 管理</Link>
          <nav aria-label="管理メニュー" className="order-3 col-span-2 flex min-w-0 gap-1 overflow-x-auto sm:order-none sm:col-auto sm:flex-1">
            <Link href="/admin/bookings" className={`${navClass} ${bookingsCurrent ? "bg-sand" : ""}`} aria-current={bookingsCurrent ? "page" : undefined}>予約支援</Link>
            {siteBookings ? <Link href="/admin/site-bookings" className={`${navClass} ${siteBookingsCurrent ? "bg-sand" : ""}`} aria-current={siteBookingsCurrent ? "page" : undefined}>サイト予約</Link> : null}
            <Link href="/admin/preparations" className={`${navClass} ${preparationsCurrent ? "bg-sand" : ""}`} aria-current={preparationsCurrent ? "page" : undefined}>掲載準備</Link>
            <Link href="/admin/operators" className={`${navClass} ${operatorsCurrent ? "bg-sand" : ""}`} aria-current={operatorsCurrent ? "page" : undefined}>運営者</Link>
            {channelManager ? <Link href="/admin/channels" className={`${navClass} ${channelsCurrent ? "bg-sand" : ""}`} aria-current={channelsCurrent ? "page" : undefined}>掲載先</Link> : null}
            <Link href="/admin/notifications" className={`${navClass} ${notificationsCurrent ? "bg-sand" : ""}`} aria-current={notificationsCurrent ? "page" : undefined}>
              通知
              {unreadCount !== null && unreadCount > 0 ? <span aria-label={`未読${unreadCount}件`} aria-live="polite" className="inline-flex min-w-5 items-center justify-center rounded-full bg-warn px-1.5 text-[0.6875rem] leading-5 text-white">{unreadCount}</span> : null}
            </Link>
          </nav>
          {actorName ? (
            <div className="order-2 flex min-w-0 items-center justify-self-end gap-2 sm:order-none">
              <span className="hidden max-w-48 truncate text-ink-soft sm:inline">{actorName}</span>
              <form method="post" action="/admin/auth/logout">
                <button type="submit" className="min-h-8 rounded-full border border-line-strong px-3 font-extrabold hover:bg-sand">ログアウト</button>
              </form>
            </div>
          ) : null}
        </div>
      </header>
      <main id="main">{children}</main>
    </div>
  );
}
