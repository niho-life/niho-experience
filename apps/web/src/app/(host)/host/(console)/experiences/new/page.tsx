import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";
import { hostPageContext } from "@/host/data";
import { config } from "@/lib/config";
import { screenProviderId } from "@/lib/host/api-path";

export const metadata: Metadata = { title: "体験を作成" };

export default async function NewHostExperiencePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!config.experienceHostPublicationApiEnabled) notFound();
  const context = await hostPageContext(await searchParams);
  if (!context) return null;
  const providerId = screenProviderId(context);
  return <HostPublicationWorkspace key={providerId ?? "none"} create providerId={providerId} />;
}
