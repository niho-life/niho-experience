import type { Metadata } from "next";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";

export const metadata: Metadata = { title: "体験を作成" };

export default function NewHostExperiencePage() {
  return <HostPublicationWorkspace create />;
}
