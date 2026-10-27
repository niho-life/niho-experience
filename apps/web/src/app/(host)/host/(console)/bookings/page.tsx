import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostBookings } from "@/components/host/HostBookings";
import { HostLiveBookings } from "@/components/host/HostLiveBookings";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostBookings } from "@/host/data";
import { isHostMock } from "@/lib/host/server";
import { isHostSupportHistoryEnabled } from "@/lib/host/support-history-server";
import { isHostFeeSummaryUiEnabled } from "@/lib/host/fee-summary-server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";

export const metadata: Metadata = { title: "予約" };

type SearchParams = Record<string, string | string[] | undefined>;

/** HTTP rollout gate while the provider booking contract is disabled: nothing that pretends to work. */
function BookingsUnavailable() {
  return (
    <HostPageBody>
      <PageHead title="予約" />
      <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
        <p className="font-extrabold">この画面は準備中です</p>
        <p className="mt-1 text-ink-soft">本番予約の確認・承認と予約者への個別連絡は、NIHO との接続を有効にしたあと、ここから行えます。</p>
      </section>
    </HostPageBody>
  );
}

/**
 * 予約 (#90): the list, one booking (`?booking=`; a sub screen on phones) and what the host
 * can do with it. The filter, the experience and the booking are the screen's own query: the
 * client screen reads them and moves between them without loading this page again.
 */
export default async function HostBookingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="予約" />;
  if (provider.memberRole === "EDITOR") notFound();
  // The first `?booking=`, as the screen reads it.
  const requested = [query.booking].flat()[0] || null;
  if (providerOperationsEnabled()) return <HostLiveBookings key={provider.id} providerId={provider.id} initialBookingId={requested} />;
  const { list, requested: opened, experiences, today, now, conversations } = await loadHostBookings(provider, requested);
  if (list.status === "unavailable") return <BookingsUnavailable />;
  // Another provider's booking, or none at all.
  if (opened?.status === "missing") notFound();
  // Keyed by provider: another provider's bookings start from their own list.
  return <HostBookings key={provider.id} bookings={list.bookings} experiences={experiences} today={today} now={now} providerId={linkProviderId} providerDataId={provider.id} supportPreview={isHostMock()} supportHistoryEnabled={isHostSupportHistoryEnabled()} feeSummaryEnabled={isHostFeeSummaryUiEnabled()} conversations={conversations} />;
}
