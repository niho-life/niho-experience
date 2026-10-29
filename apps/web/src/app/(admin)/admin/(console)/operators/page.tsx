import type { Metadata } from "next";
import { AdminProductOperators } from "@/components/admin/AdminProductOperators";
import { config } from "@/lib/config";
import { isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { productOperatorRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "商品運営者 | NIHO 管理" };

export default async function AdminOperatorsPage() {
  if (!config.hostConsoleEnabled || !isAdminHttp()) return null;
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const repository = productOperatorRepository();
  if (!repository) return <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">商品運営者の台帳を読み込めませんでした。</p></main>;
  let initial;
  try { initial = await repository.adminSnapshot(); }
  catch { return <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">商品運営者の台帳を読み込めませんでした。</p></main>; }
  return <AdminProductOperators initial={initial} />;
}
