import type { Metadata } from "next";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";

export const metadata: Metadata = { title: "代理登録の商品編集" };
export default async function AdminProductPage({ params }: { params: Promise<{ providerId: string; productId: string }> }) {
  const { providerId, productId } = await params;
  const provider = encodeURIComponent(providerId);
  return <HostPublicationWorkspace productId={productId} mode="admin-draft" apiBase={`/admin/api/product-workspaces/${provider}/products`} experiencesBase={`/admin/products/${provider}`} createHref={`/admin/products/${provider}/new`} />;
}
