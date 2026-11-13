import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminBookings } from "@/components/admin/AdminBookings";
import { AdminHttpBookings } from "@/components/admin/AdminHttpBookings";
import { AdminLeaveGuardProvider } from "@/components/admin/AdminLeaveGuard";
import { AdminSignedInNotice } from "@/components/admin/AdminSignedInNotice";
import { MOCK_ADMIN_HOSTS, MOCK_ADMIN_TODAY } from "@/admin/mock";
import { adminPreviewBookings } from "@/admin/preview-store";
import { isAdminHttp, isAdminHttpRead, isAdminPreview, isAdminReadPreview, loadAdminHttpSession, readAdminSession } from "@/lib/admin/server";
import { adminRedirectFrom } from "@/lib/admin/sections-server";
import { isAdminSupportCaseUiEnabled } from "@/lib/admin/case-server";
import { isAdminOperationsUiEnabled } from "@/lib/admin/operations-server";
import { isAdminFeeSummaryUiEnabled } from "@/lib/admin/fee-summary-server";

export const metadata: Metadata = { title: "予約支援" };

export default async function AdminBookingsPage() {
  if (isAdminHttp()) {
    const load = await loadAdminHttpSession();
    if (load.status !== "ok") return null;
    if (isAdminHttpRead()) return <AdminLeaveGuardProvider><AdminHttpBookings supportCaseEnabled={isAdminSupportCaseUiEnabled()} operationsEnabled={isAdminOperationsUiEnabled()} feeSummaryEnabled={isAdminFeeSummaryUiEnabled()} /></AdminLeaveGuardProvider>;
    const elsewhere = adminRedirectFrom("/admin/bookings");
    if (elsewhere) redirect(elsewhere);
    return <AdminSignedInNotice load={load} nihoTitle="予約支援APIは準備中です" />;
  }
  if (!isAdminPreview()) return null;
  const session = await readAdminSession();
  if (!session) return null;
  if (isAdminReadPreview()) return <AdminLeaveGuardProvider><AdminHttpBookings supportCaseEnabled={isAdminSupportCaseUiEnabled()} operationsEnabled={isAdminOperationsUiEnabled()} feeSummaryEnabled={isAdminFeeSummaryUiEnabled()} /></AdminLeaveGuardProvider>;
  return <AdminBookings initialBookings={adminPreviewBookings(session.id, session.expiresAt)} hosts={MOCK_ADMIN_HOSTS} today={MOCK_ADMIN_TODAY} />;
}
