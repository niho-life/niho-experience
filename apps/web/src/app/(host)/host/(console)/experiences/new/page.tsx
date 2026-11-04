import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";
import { config } from "@/lib/config";

export const metadata: Metadata = { title: "体験を作成" };

export default function NewHostExperiencePage() {
  if (!config.experienceHostPublicationApiEnabled) notFound();
  return <HostPublicationWorkspace create />;
}
