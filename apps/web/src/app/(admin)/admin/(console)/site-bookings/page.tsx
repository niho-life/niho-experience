import type { Metadata } from "next";
import type { SupportQueue } from "@niho-experience/experience-store";
import { notFound } from "next/navigation";
import { AdminSiteBookings } from "@/components/admin/AdminSiteBookings";
import { config } from "@/lib/config";
import { isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { bookingCancellations } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "サイト予約の取消・返金 | NIHO 管理" };
export const dynamic = "force-dynamic";

/**
 * サイト予約 (#285 slice 7): the bookings made on this site that need NIHO support (取消の依頼, 確認待ちの支払い, 返金の
 * 要対応) and support's actions on them. Signed in through the Admin console (the layout shows the other states).
 */
export default async function AdminSiteBookingsPage() {
  if (!config.guestBookingEnabled || !isAdminHttp()) notFound();
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const cancellations = bookingCancellations();
  const failed = <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">サイト予約を読み込めませんでした。時間をおいて、もう一度お試しください。</p></main>;
  if (!cancellations) return failed;
  let queue: SupportQueue;
  try {
    queue = await cancellations.supportQueue({ limit: 100 });
  } catch {
    return failed;
  }
  return <AdminSiteBookings initial={queue} />;
}
