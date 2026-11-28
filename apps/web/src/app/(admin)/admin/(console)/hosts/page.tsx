import type { Metadata } from "next";
import { AdminHosts } from "@/components/admin/AdminHosts";
import { config } from "@/lib/config";
import { isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { experiencePublicationRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "ホスト | NIHO 管理", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** ホストの一覧と運営停止 (#711): signed-in Admins only; the layout already ended a session that is not one. */
export default async function AdminHostsPage() {
  if (!config.experiencePublicationsEnabled || !isAdminHttp()) return null;
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const repository = experiencePublicationRepository();
  const unavailable = <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">ホストの一覧を読み込めませんでした。</p></main>;
  if (!repository) return unavailable;
  let hosts;
  try { hosts = await repository.listAdminHosts({ nihoUserId: loaded.actor.id }); } catch { return unavailable; }
  return <AdminHosts initial={hosts} />;
}
