import type { Metadata } from "next";
import { HostPublicationWorkspace } from "@/components/host/HostPublicationWorkspace";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { hostPageContext } from "@/host/data";
import { config } from "@/lib/config";
import { withProvider } from "@/lib/host/routes";

export const metadata: Metadata = { title: "体験" };

type SearchParams = Record<string, string | string[] | undefined>;

/** OWNER products are managed by Experience's publication API. */
export default async function HostExperiencesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await hostPageContext(await searchParams);
  if (!context) return null;
  if (!context.provider) return <HostRegisterPrompt title="体験" />;
  const bookingGuideHref = config.experienceHostPublicationApiEnabled
    ? withProvider("/host/booking-guides", context.linkProviderId)
    : undefined;
  return <HostPublicationWorkspace bookingGuideHref={bookingGuideHref} />;
}
