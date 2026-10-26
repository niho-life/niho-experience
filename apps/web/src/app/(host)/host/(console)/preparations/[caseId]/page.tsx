import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostPreparation } from "@/components/host/HostPreparation";
import { HostPageBody } from "@/components/host/ui";
import { config } from "@/lib/config";
import { preparationCaseIdOrNull } from "@/lib/host/routes";
import { isPreparationUiEnabled } from "@/lib/preparations/server";

export const metadata: Metadata = { title: "掲載準備" };

export default async function HostPreparationPage({ params }: { params: Promise<{ caseId: string }> }) {
  if (!isPreparationUiEnabled()) notFound();
  const caseId = preparationCaseIdOrNull((await params).caseId);
  if (!caseId) notFound();
  return <HostPageBody><HostPreparation caseId={caseId} nihoOrigin={config.nihoWebOrigin} /></HostPageBody>;
}
