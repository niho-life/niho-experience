import type { Metadata } from "next";
import { AdminProviderWorkspace } from "@/components/admin/AdminProviderWorkspace";

export const metadata: Metadata = { title: "代理登録の商品" };
export default async function AdminProviderProductsPage({ params }: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params;
  return <AdminProviderWorkspace key={providerId} providerId={providerId} />;
}
