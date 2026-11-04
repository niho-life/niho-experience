import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import { isAdminHttp } from "@/lib/admin/server";

export default function AdminProductsLayout({ children }: { children: React.ReactNode }) {
  if (!isAdminHttp() || !config.experienceHostPublicationApiEnabled) notFound();
  return children;
}
