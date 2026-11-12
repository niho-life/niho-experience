import type { Metadata } from "next";
import { AdminProductOperators } from "@/components/admin/AdminProductOperators";
import { productOperatorsPreview } from "@/admin/product-operators-preview";
import { config } from "@/lib/config";
import { isAdminHttp, isAdminPreview, loadAdminHttpSession } from "@/lib/admin/server";
import { productOperatorRepository } from "@/lib/experience/store-server";

export const metadata: Metadata = { title: "運営者 | NIHO 管理" };
export const dynamic = "force-dynamic";

/** The page is drawn per request; the list judges 期限切れ against this moment. */
const nowMs = () => Date.now();

/**
 * 運営者 (#196, #542). In mock mode with ADMIN_PRODUCT_OPERATORS_PREVIEW_ENABLED, synthetic data for Playwright, whose
 * browser stubs answer the API (the signed-in preview session is checked by the layout).
 */
export default async function AdminOperatorsPage() {
  if (isAdminPreview() && config.adminProductOperatorsPreviewEnabled) return <AdminProductOperators initial={productOperatorsPreview()} now={nowMs()} />;
  if (!config.hostConsoleEnabled || !isAdminHttp()) return null;
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return null;
  const repository = productOperatorRepository();
  if (!repository) return <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">運営者の台帳を読み込めませんでした。</p></main>;
  let initial;
  try { initial = await repository.adminSnapshot(); }
  catch { return <main className="mx-auto max-w-3xl px-4 py-10"><p role="alert">運営者の台帳を読み込めませんでした。</p></main>; }
  return <AdminProductOperators initial={initial} now={nowMs()} />;
}
