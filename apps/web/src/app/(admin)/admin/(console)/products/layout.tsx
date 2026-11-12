import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import { isAdminHttp, isAdminPreview } from "@/lib/admin/server";

export default function AdminProductsLayout({ children }: { children: React.ReactNode }) {
  const previewOpen = isAdminPreview() && config.adminProductWorkspacesPreviewEnabled;
  if (!previewOpen && (!isAdminHttp() || !config.experienceHostPublicationApiEnabled)) notFound();
  return children;
}
