import type { Metadata } from "next";
import { AdminNotifications } from "@/components/admin/AdminNotifications";
import { AdminHttpNotifications } from "@/components/admin/AdminHttpNotifications";
import { AdminSignedInNotice } from "@/components/admin/AdminSignedInNotice";
import { isAdminHttp, isAdminHttpRead, isAdminPreview, isAdminReadPreview, loadAdminHttpSession } from "@/lib/admin/server";

export const metadata: Metadata = { title: "通知" };

export default async function AdminNotificationsPage() {
  if (isAdminHttp()) {
    const load = await loadAdminHttpSession();
    if (load.status !== "ok") return null;
    if (isAdminHttpRead()) return <AdminHttpNotifications />;
    return <AdminSignedInNotice load={load} nihoTitle="通知APIは準備中です" />;
  }
  if (!isAdminPreview()) return null;
  if (isAdminReadPreview()) return <AdminHttpNotifications />;
  return <AdminNotifications />;
}
