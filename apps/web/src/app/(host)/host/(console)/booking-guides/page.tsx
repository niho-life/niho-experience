import type { Metadata } from "next";
import { HostBookingGuides } from "@/components/host/HostBookingGuides";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HOST_EXPERIENCES_PATH, withProvider } from "@/lib/host/routes";
import { hostPageContext } from "@/host/data";

export const metadata: Metadata = { title: "予約後の集合案内" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function HostBookingGuidesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await hostPageContext(await searchParams);
  if (!context) return null;
  if (!context.provider) return <HostRegisterPrompt title="予約後の集合案内" />;
  return <HostBookingGuides key={context.provider.id} backHref={withProvider(HOST_EXPERIENCES_PATH, context.linkProviderId)} owner={context.provider.memberRole === "OWNER"} />;
}
