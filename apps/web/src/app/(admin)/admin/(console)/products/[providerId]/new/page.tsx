import type { Metadata } from "next";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";

export const metadata: Metadata = { title: "商品の代理登録" };
export default async function NewAdminProductPage({ params }: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params;
  const encoded = encodeURIComponent(providerId);
  return <HostPublicationWorkspace create mode="admin-draft" apiBase={`/admin/api/product-workspaces/${encoded}/products`} experiencesBase={`/admin/products/${encoded}`} createHref={`/admin/products/${encoded}/new`} />;
}
