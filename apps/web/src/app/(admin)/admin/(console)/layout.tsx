import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminRefreshGate, AdminSessionEndGate, AdminSessionKeeper } from "@/components/admin/AdminSessionKeeper";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { adminPreviewNotifications } from "@/admin/preview-store";
import { ADMIN_ENTRY_PATH } from "@/lib/admin/routes";
import { adminReadApiClient, isAdminHttp, isAdminHttpRead, isAdminPreview, loadAdminHttpSession, readAdminSession, requireAdminConsole } from "@/lib/admin/server";
import { currentAdminSections } from "@/lib/admin/sections-server";

export default async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  requireAdminConsole();
  // Before the sign-in is known the menu is not drawn: the sections are the signed-in console's.
  const none = [] as const;
  if (isAdminPreview()) {
    const session = await readAdminSession();
    if (!session) redirect(ADMIN_ENTRY_PATH);
    const { unreadCount } = adminPreviewNotifications(session.id, session.expiresAt);
    return <AdminShell sections={currentAdminSections()} actorName={session.actorName} accountKind="preview" unreadCount={unreadCount}>{children}</AdminShell>;
  }
  if (!isAdminHttp()) redirect(ADMIN_ENTRY_PATH);
  const load = await loadAdminHttpSession();
  if (load.status === "signed-out") redirect(ADMIN_ENTRY_PATH);
  if (load.status === "refresh") {
    return <AdminShell sections={none} actorName={null} accountKind="niho"><div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><AdminRefreshGate /></section></div></AdminShell>;
  }
  if (load.status === "rejected") {
    return <AdminShell sections={none} actorName={null} accountKind="niho"><div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><AdminSessionEndGate /></section></div></AdminShell>;
  }
  if (load.status === "error") {
    return <AdminShell sections={none} actorName={null} accountKind="niho"><div className="mx-auto max-w-2xl px-4 py-12"><section role="alert" className={`${HOST_SURFACE} p-6`}><h1 className="font-display text-2xl font-medium">管理者情報を確認できませんでした</h1><p className="mt-2 text-ink-soft">通信の状態を確かめて、もう一度お試しください。</p><a href={ADMIN_ENTRY_PATH} className="mt-5 inline-flex min-h-11 items-center rounded-full border border-line-strong px-5 font-extrabold hover:bg-sand">もう一度試す</a></section></div></AdminShell>;
  }
  let unreadCount: number | null = null;
  // NIHO's notifications are read with the NIHO admin token: never for a Google sign-in (isAdminHttpRead is off then).
  if (isAdminHttpRead() && load.kind === "niho") {
    const notifications = await adminReadApiClient(load.session).listNotifications({ limit: 1 });
    if (!notifications.ok && notifications.kind === "rejected") {
      return <AdminShell sections={none} actorName={null} accountKind="niho"><div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><AdminSessionEndGate /></section></div></AdminShell>;
    }
    if (notifications.ok) unreadCount = notifications.data.unreadCount;
  }
  const actorName = load.actor.displayName?.trim() || (load.kind === "niho" ? "NIHO 管理者" : "管理者");
  // A Google sign-in (ADR 0003) has no token to renew: the keeper only ends the page at the session's absolute end
  // (the server ends an idle session on its own).
  const keeper = load.kind === "niho"
    ? { idTokenExpiresAt: load.session.idTokenExpiresAt, connectionExpiresAt: load.session.connectionExpiresAt }
    : { idTokenExpiresAt: load.session.absoluteExpiresAt, connectionExpiresAt: load.session.absoluteExpiresAt };
  return <><AdminSessionKeeper idTokenExpiresAt={keeper.idTokenExpiresAt} connectionExpiresAt={keeper.connectionExpiresAt} /><AdminShell sections={currentAdminSections()} actorName={actorName} accountKind={load.kind === "niho" ? "niho" : "google"} unreadCount={unreadCount}>{children}</AdminShell></>;
}
