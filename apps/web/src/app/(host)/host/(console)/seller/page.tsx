import type { Metadata } from "next";
import { HostSellerDisclosureForm } from "@/components/host/HostSellerDisclosureForm";
import { HostSettingsBackLink } from "@/components/host/HostSettingsBackLink";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { HostProviderRequiredNotice } from "@/components/host/HostProviderRequired";
import { hostPageContext } from "@/host/data";
import { screenProviderId } from "@/lib/host/api-path";

export const metadata: Metadata = { title: "販売者表示" };

export default async function HostSellerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await hostPageContext(await searchParams);
  if (!context) return null;
  const providerId = screenProviderId(context);
  return <HostPageBody><HostSettingsBackLink providerId={providerId ?? undefined} /><PageHead title="販売者表示" /><p className="mb-4 text-ink-soft">ここで入力した内容は、旅行者向けの「特定商取引法に基づく表記」ページに載ります。ページは体験ごとにこのサイトが作り、料金・キャンセル条件も自動で載せます。法的な適合性を自動で保証する機能ではありません。</p>{context.providerNotFound ? <HostProviderRequiredNotice /> : <HostSellerDisclosureForm key={providerId ?? "none"} providerId={providerId} />}</HostPageBody>;
}
