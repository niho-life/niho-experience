import type { Metadata } from "next";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";

export const metadata: Metadata = { title: "体験の編集" };

export default async function HostExperiencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HostPublicationWorkspace productId={id} />;
}
