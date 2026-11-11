import type { Metadata } from "next";
import type { ExperienceSettlementSummary, ExperienceSupportNotification, SupportEnabledBookingsPage, SupportQueue } from "@niho-experience/experience-store";
import { notFound } from "next/navigation";
import { adminSiteBookingsPreview } from "@/admin/site-bookings-preview";
import { AdminSiteBookings } from "@/components/admin/AdminSiteBookings";
import { config } from "@/lib/config";
import { isAdminHttp, isAdminPreview, loadAdminHttpSession } from "@/lib/admin/server";
import { bookingCancellations, experienceSupportRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "サイト予約の取消・返金 | NIHO 管理" };
export const dynamic = "force-dynamic";

/**
 * サイト予約 (#285 slice 7): the bookings made on this site that need NIHO support (取消の依頼, 確認待ちの支払い, 返金の
 * 要対応) and support's actions on them, and the bookings accepted with support ON (#121/#128) to open one that is not in
 * the queue. Signed in through the Admin console (the layout shows the other states). In mock mode with
 * ADMIN_SITE_BOOKINGS_PREVIEW_ENABLED, synthetic data for Playwright, whose browser stubs answer the API.
 */
export default async function AdminSiteBookingsPage() {
  if (isAdminPreview() && config.adminSiteBookingsPreviewEnabled) {
    const preview = adminSiteBookingsPreview();
    return <AdminSiteBookings initial={preview.queue} supportBookings={preview.supportBookings} />;
  }
  if (!config.guestBookingEnabled || !isAdminHttp()) notFound();
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const cancellations = bookingCancellations();
  const support = experienceSupportRepository();
  const failed = <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">サイト予約を読み込めませんでした。時間をおいて、もう一度お試しください。</p></main>;
  if (!cancellations || !support) return failed;
  let queue: SupportQueue;
  let supportBookings: SupportEnabledBookingsPage;
  let notifications: ExperienceSupportNotification[];
  let settlements: ExperienceSettlementSummary[];
  try {
    queue = await cancellations.supportQueue({ limit: 100 });
    [supportBookings, notifications, settlements] = await Promise.all([
      cancellations.supportEnabledBookings(),
      support.listNotifications({ nihoUserId: loaded.actor.id }, { limit: 50 }),
      support.listAdminSummaries(100),
    ]);
  } catch {
    return failed;
  }
  return <AdminSiteBookings initial={queue} supportBookings={supportBookings} notifications={notifications} settlements={settlements}
    managedCompensationAvailable={Boolean(process.env.EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID?.trim())} />;
}
