import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminChannelWorkspace } from "@/components/admin/AdminChannelWorkspace";
import { AdminLeaveGuardProvider } from "@/components/admin/AdminLeaveGuard";
import { loadAdminHttpSession, readAdminSession } from "@/lib/admin/server";
import { channelManagerEnabled, channelWorkspacePreviewEnabled } from "@/lib/experience/channel-runtime";
import { experienceStore } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "掲載先 | NIHO 管理" };

export default async function AdminChannelsPage() {
  if (channelWorkspacePreviewEnabled()) {
    if (!await readAdminSession()) notFound();
    return <AdminLeaveGuardProvider><p role="note" className="px-4 pt-4 text-xs text-muted">プレビュー（合成データ）</p><AdminChannelWorkspace initialProviders={[{ id: "synthetic-a", displayName: "サンプルの台所" }, { id: "synthetic-b", displayName: "サンプル工房" }]} /></AdminLeaveGuardProvider>;
  }
  if (!channelManagerEnabled()) notFound();
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const store = experienceStore();
  if (!store) return <div className="mx-auto max-w-3xl px-4 py-10"><p role="alert">掲載先の設定を読み込めませんでした。</p></div>;
  let providers;
  try { providers = await store.listInventoryAdminProviders({ nihoUserId: loaded.verified.actor.id }); }
  catch {
    return <div className="mx-auto max-w-3xl px-4 py-10"><p role="alert">掲載先の設定を読み込めませんでした。</p></div>;
  }
  return <AdminLeaveGuardProvider><AdminChannelWorkspace initialProviders={providers} /></AdminLeaveGuardProvider>;
}
