import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminRefreshGate, AdminSessionEndGate, AdminSessionKeeper } from "@/components/admin/AdminSessionKeeper";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { adminPreviewNotifications } from "@/admin/preview-store";
import { ADMIN_ENTRY_PATH } from "@/lib/admin/routes";
import { adminReadApiClient, isAdminHttp, isAdminHttpRead, isAdminPreview, loadAdminHttpSession, readAdminSession, requireAdminConsole } from "@/lib/admin/server";
import { channelManagerEnabled, channelWorkspacePreviewEnabled } from "@/lib/experience/channel-runtime";
import { config } from "@/lib/config";

export default async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  requireAdminConsole();
  const channelManager = channelManagerEnabled() || channelWorkspacePreviewEnabled();
  if (isAdminPreview()) {
    const session = await readAdminSession();
    if (!session) redirect(ADMIN_ENTRY_PATH);
    const { unreadCount } = adminPreviewNotifications(session.id, session.expiresAt);
    return <AdminShell actorName={session.actorName} unreadCount={unreadCount} channelManager={channelManager}>{children}</AdminShell>;
  }
  if (!isAdminHttp()) redirect(ADMIN_ENTRY_PATH);
  const load = await loadAdminHttpSession();
  if (load.status === "signed-out") redirect(ADMIN_ENTRY_PATH);
  if (load.status === "refresh") {
    return <AdminShell actorName={null} unreadCount={null} channelManager={channelManager}><div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><AdminRefreshGate /></section></div></AdminShell>;
  }
  if (load.status === "rejected") {
    return <AdminShell actorName={null} unreadCount={null} channelManager={channelManager}><div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><AdminSessionEndGate /></section></div></AdminShell>;
  }
  if (load.status === "error") {
    return <AdminShell actorName={null} unreadCount={null} channelManager={channelManager}><div className="mx-auto max-w-2xl px-4 py-12"><section role="alert" className={`${HOST_SURFACE} p-6`}><h1 className="font-display text-2xl font-medium">管理者情報を確認できませんでした</h1><p className="mt-2 text-ink-soft">通信の状態を確かめて、もう一度お試しください。</p><a href={ADMIN_ENTRY_PATH} className="mt-5 inline-flex min-h-11 items-center rounded-full border border-line-strong px-5 font-extrabold hover:bg-sand">もう一度試す</a></section></div></AdminShell>;
  }
  let unreadCount: number | null = null;
  if (isAdminHttpRead()) {
    const notifications = await adminReadApiClient(load.session).listNotifications({ limit: 1 });
    if (!notifications.ok && notifications.kind === "rejected") {
      return <AdminShell actorName={null} unreadCount={null} channelManager={channelManager}><div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><AdminSessionEndGate /></section></div></AdminShell>;
    }
    if (notifications.ok) unreadCount = notifications.data.unreadCount;
  }
  const actorName = load.verified.actor.displayName?.trim() || "NIHO 管理者";
  // サイト予約の取消・返金 (#285 slice 7): this site's bookings, with the Admin sign-in above.
  const siteBookings = config.guestBookingEnabled;
  return <><AdminSessionKeeper idTokenExpiresAt={load.session.idTokenExpiresAt} connectionExpiresAt={load.session.connectionExpiresAt} /><AdminShell actorName={actorName} unreadCount={unreadCount} channelManager={channelManager} siteBookings={siteBookings}>{children}</AdminShell></>;
}
