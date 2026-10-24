import type { Metadata } from "next";
import { AdminBookings } from "@/components/admin/AdminBookings";
import { AdminHttpBookings } from "@/components/admin/AdminHttpBookings";
import { AdminLeaveGuardProvider } from "@/components/admin/AdminLeaveGuard";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { MOCK_ADMIN_HOSTS, MOCK_ADMIN_TODAY } from "@/admin/mock";
import { adminPreviewBookings } from "@/admin/preview-store";
import { isAdminHttp, isAdminHttpRead, isAdminPreview, isAdminReadPreview, loadAdminHttpSession, readAdminSession } from "@/lib/admin/server";
import { isAdminSupportCaseUiEnabled } from "@/lib/admin/case-server";
import { isAdminOperationsUiEnabled } from "@/lib/admin/operations-server";
import { isAdminFeeSummaryUiEnabled } from "@/lib/admin/fee-summary-server";

export const metadata: Metadata = { title: "予約支援" };

export default async function AdminBookingsPage() {
  if (isAdminHttp()) {
    const load = await loadAdminHttpSession();
    if (load.status !== "ok") return null;
    if (isAdminHttpRead()) return <AdminLeaveGuardProvider><AdminHttpBookings supportCaseEnabled={isAdminSupportCaseUiEnabled()} operationsEnabled={isAdminOperationsUiEnabled()} feeSummaryEnabled={isAdminFeeSummaryUiEnabled()} /></AdminLeaveGuardProvider>;
    const expires = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(load.verified.connection.expiresAt);
    return <div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><p className="text-xs font-extrabold tracking-[0.08em] text-moss">NIHO 接続済み</p><h1 className="mt-2 font-display text-2xl font-medium">予約支援APIは準備中です</h1><dl className="mt-5 grid gap-3 rounded-xl bg-sand/55 p-4 sm:grid-cols-2"><div><dt className="text-xs font-extrabold text-muted">確認済み管理者</dt><dd className="mt-1 font-bold">{load.verified.actor.displayName?.trim() || "NIHO 管理者"}</dd></div><div><dt className="text-xs font-extrabold text-muted">接続期限</dt><dd className="mt-1 font-bold">{expires} JST</dd></div></dl><p className="mt-5 text-ink-soft">管理者認証だけが接続されています。予約・通知の読取flagはOFFです。NIHO側の配備と受入後に有効化します。</p></section></div>;
  }
  if (!isAdminPreview()) return null;
  const session = await readAdminSession();
  if (!session) return null;
  if (isAdminReadPreview()) return <AdminLeaveGuardProvider><AdminHttpBookings supportCaseEnabled={isAdminSupportCaseUiEnabled()} operationsEnabled={isAdminOperationsUiEnabled()} feeSummaryEnabled={isAdminFeeSummaryUiEnabled()} /></AdminLeaveGuardProvider>;
  return <AdminBookings initialBookings={adminPreviewBookings(session.id, session.expiresAt)} hosts={MOCK_ADMIN_HOSTS} today={MOCK_ADMIN_TODAY} />;
}
