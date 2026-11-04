import type { Metadata } from "next";
import { HostCalendarWorkspace } from "@/components/host/HostCalendarWorkspace";

export const metadata: Metadata = { title: "代理登録の開催枠" };
export default async function AdminProductCalendarPage({ params }: { params: Promise<{ providerId: string; productId: string }> }) {
  const { providerId, productId } = await params;
  const provider = encodeURIComponent(providerId);
  const product = encodeURIComponent(productId);
  return <div className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-7"><HostCalendarWorkspace
    providerId={providerId}
    initialExperienceId={productId}
    legacyManagementUrl={null}
    draftPreparation
    apiPath={`/admin/api/product-workspaces/${provider}/products/${product}/calendar`}
    productEditBase={`/admin/products/${provider}`}
  /></div>;
}
