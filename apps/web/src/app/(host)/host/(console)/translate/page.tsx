import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostStandaloneTranslate } from "@/components/host/HostStandaloneTranslate";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext } from "@/host/data";
import { translateRoomsEnabled } from "@/lib/host/translate-rooms-server";

export const metadata: Metadata = { title: "対面通訳" };
type SearchParams = Record<string, string | string[] | undefined>;

export default async function HostStandaloneTranslatePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await hostPageContext(await searchParams);
  if (!context) return null;
  if (!translateRoomsEnabled() || context.providerNotFound || context.provider?.memberRole !== "OWNER") notFound();
  const provider = context.provider;
  return (
    <HostPageBody>
      <PageHead title="対面通訳" />
      <HostStandaloneTranslate key={provider.id} providerId={provider.id} providerName={provider.displayName} />
    </HostPageBody>
  );
}
