import type { Metadata } from "next";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";

export const metadata: Metadata = { title: "代理登録の商品" };
export default async function AdminProviderProductsPage({ params }: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params;
  const encoded = encodeURIComponent(providerId);
  return <HostPublicationWorkspace mode="admin-draft" apiBase={`/admin/api/product-workspaces/${encoded}/products`} experiencesBase={`/admin/products/${encoded}`} createHref={`/admin/products/${encoded}/new`} />;
}
