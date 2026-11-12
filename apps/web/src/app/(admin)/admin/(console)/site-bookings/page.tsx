import type { Metadata } from "next";
import type { AdminAssignmentRow, ExperienceSettlementSummary, ExperienceSupportNotification, ManagedBookingApprovalPage, SupportEnabledBookingsPage, SupportQueue } from "@niho-experience/experience-store";
import { notFound } from "next/navigation";
import { adminSiteBookingsPreview } from "@/admin/site-bookings-preview";
import { AdminSiteBookings } from "@/components/admin/AdminSiteBookings";
import { AdminBookingApprovals } from "@/components/admin/AdminBookingApprovals";
import { AdminOccurrenceAssignments } from "@/components/admin/AdminOccurrenceAssignments";
import { config } from "@/lib/config";
import { isAdminHttp, isAdminPreview, loadAdminHttpSession } from "@/lib/admin/server";
import { bookingCancellations, experienceSupportRepository, managedBookingApprovalRepository, occurrenceAssignmentRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "予約 | NIHO 管理" };
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
    return <AdminSiteBookings initial={preview.queue} supportBookings={preview.supportBookings} notifications={preview.notifications} />;
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
  let approvalRequests: ManagedBookingApprovalPage | null = null;
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
  const approvalsEnabled = config.managedSalesEnabled && config.managedSalesWebhooksEnabled;
  if (approvalsEnabled) {
    try { approvalRequests = await managedBookingApprovalRepository()?.listPending({ nihoUserId: loaded.actor.id }) ?? null; }
    catch { /* The refund and cancellation queue remains available independently. */ }
  }
  // 開催回の担当 (#535 v0): independent of the approval list; a read failure leaves the rest of the page as it is.
  let assignmentRows: readonly AdminAssignmentRow[] | null = null;
  const assignmentsEnabled = config.occurrenceAssignmentEnabled && config.managedSalesEnabled;
  if (assignmentsEnabled) {
    try { assignmentRows = await occurrenceAssignmentRepository()?.adminList({ nihoUserId: loaded.actor.id }) ?? null; }
    catch { /* The queues below remain available. */ }
  }
  const assignments = assignmentRows ? <AdminOccurrenceAssignments initial={assignmentRows} /> : assignmentsEnabled ? <p role="alert">開催回の担当を読み込めませんでした。ページを再読み込みしてください。</p> : null;
  const approvals = approvalRequests ? <AdminBookingApprovals initial={approvalRequests} /> : approvalsEnabled ? <p role="alert">承認待ちの申込を読み込めませんでした。ページを再読み込みしてください。</p> : null;
  // 承認待ちと開催回の担当は「要対応」の先頭に入る (#542 S3)。それぞれが自分の件数を一覧へ知らせる (admin-todo-slot.tsx)。
  const todoSlot = approvals || assignments ? <div className="grid gap-3 [&>section]:mt-0">{approvals}{assignments}</div> : null;
  const todoSlotCount = (approvalRequests?.requests.length ?? 0) + (assignmentRows?.filter((row) => row.status === "OPEN").length ?? 0);
  return <AdminSiteBookings initial={queue} supportBookings={supportBookings} notifications={notifications} settlements={settlements}
    managedCompensationAvailable={config.managedSalesWebhooksEnabled} todoSlot={todoSlot} todoSlotCount={todoSlotCount} />;
}
