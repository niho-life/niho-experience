import type { Metadata } from "next";
import { AdminPeople } from "@/components/admin/AdminPeople";
import { config } from "@/lib/config";
import { isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { peopleListingRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "街の人 | NIHO 管理", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** 街の人 (#564): which providers the Japanese site shows on 街の人. Signed-in Admins only; the layout already ended a session that is not one. */
export default async function AdminPeoplePage() {
  if (!isAdminHttp() || !config.experiencePublicationsEnabled) return null;
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const repository = peopleListingRepository();
  const unavailable = <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">街の人の一覧を読み込めませんでした。</p></main>;
  if (!repository) return unavailable;
  let initial;
  try { initial = await repository.adminList(); } catch { return unavailable; }
  return <AdminPeople initial={[...initial]} />;
}
