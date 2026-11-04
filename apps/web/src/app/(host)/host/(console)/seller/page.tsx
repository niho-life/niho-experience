import type { Metadata } from "next";
import { HostSellerDisclosureForm } from "@/components/host/HostSellerDisclosureForm";
import { HostPageBody, PageHead } from "@/components/host/ui";

export const metadata: Metadata = { title: "販売者表示" };

export default function HostSellerPage() {
  return <HostPageBody><PageHead title="販売者表示" /><p className="mb-4 text-ink-soft">体験を販売する方の公開情報を準備し、公開前に内容を確認します。法的な適合性を自動で保証する機能ではありません。</p><HostSellerDisclosureForm /></HostPageBody>;
}
