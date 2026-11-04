import type { Metadata } from "next";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";

export const metadata: Metadata = { title: "体験" };

/** OWNER products are managed by Experience's publication API. */
export default function HostExperiencesPage() {
  return <HostPublicationWorkspace />;
}
