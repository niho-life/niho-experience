import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminPreparationDetail } from "@/components/admin/AdminPreparationDetail";
import { config } from "@/lib/config";
import { preparationCaseIdOrNull } from "@/lib/host/routes";
import { isPreparationUiEnabled } from "@/lib/preparations/server";

export const metadata: Metadata = { title: "掲載準備の詳細" };

export default async function AdminPreparationDetailPage({ params }: { params: Promise<{ caseId: string }> }) {
  if (!isPreparationUiEnabled()) notFound();
  const { caseId: rawCaseId } = await params;
  const caseId = preparationCaseIdOrNull(rawCaseId);
  if (!caseId) notFound();
  return <AdminPreparationDetail caseId={caseId} nihoOrigin={config.nihoWebOrigin} />;
}
