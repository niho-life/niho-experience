import type { Metadata } from "next";
import { AdminInquiries } from "@/components/admin/AdminInquiries";
import { config } from "@/lib/config";
import { isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { groupInquiryRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "相談 | NIHO 管理", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** 団体・個別の相談の受付一覧 (#532): signed-in Admins only; the layout already ended a session that is not one. */
export default async function AdminInquiriesPage() {
  if (!config.groupInquiryEnabled || !isAdminHttp()) return null;
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const repository = groupInquiryRepository();
  const unavailable = <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">相談の一覧を読み込めませんでした。</p></main>;
  if (!repository) return unavailable;
  let initial;
  try { initial = await repository.list(); } catch { return unavailable; }
  return <AdminInquiries initial={initial} />;
}
