import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostBookings } from "@/components/host/HostBookings";
import { HostLiveBookings } from "@/components/host/HostLiveBookings";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostBookings } from "@/host/data";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "@/host/site-bookings";
import { loadSiteBookings, type HostSiteBookingsLoad } from "@/host/site-bookings-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock } from "@/lib/host/server";
import { isHostSupportHistoryEnabled } from "@/lib/host/support-history-server";
import { isHostFeeSummaryUiEnabled } from "@/lib/host/fee-summary-server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";
import { translateRoomsEnabled, translateRoomsEntry } from "@/lib/host/translate-rooms-server";

export const metadata: Metadata = { title: "予約" };

type SearchParams = Record<string, string | string[] | undefined>;

const UNAVAILABLE = {
  title: "この画面は準備中です",
  body: "本番予約の確認・承認と予約者への個別連絡は、NIHO との接続を有効にしたあと、ここから行えます。",
};

/** HTTP rollout gate while the provider booking contract is disabled: nothing that pretends to work. Also the site bookings' read failure. */
function BookingsUnavailable({ title = UNAVAILABLE.title, body = UNAVAILABLE.body }: { title?: string; body?: string }) {
  return (
    <HostPageBody>
      <PageHead title="予約" />
      <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
        <p className="font-extrabold">{title}</p>
        <p className="mt-1 text-ink-soft">{body}</p>
      </section>
    </HostPageBody>
  );
}

/** Above NIHO's bookings when this site's could not be read beside them: NIHO's list stays the screen. */
function SiteBookingsFailed() {
  return (
    <p role="alert" className="mb-3.5 rounded-xl bg-danger-pale p-3 text-sm font-bold text-danger">
      このサイトで受けた予約を読み込めませんでした。NIHO の予約だけを表示しています。時間をおいて、ページを読み込み直してください。
    </p>
  );
}

/**
 * The bookings made on this site (#285 slice 8, experience DB) in the bookings screen; with `niho`, NIHO's beside
 * them on one list (#84), where a `?booking=` this site does not have may be NIHO's (the screen reads it from NIHO).
 */
function SiteBookings({ site, provider, linkProviderId, niho }: { site: Exclude<HostSiteBookingsLoad, { status: "closed" }>; provider: HostProvider; linkProviderId: string | null; niho: { providerId: string; translate: { today: string } | null } | null }) {
  if (site.status === "error") return <BookingsUnavailable title="予約を読み込めませんでした" body={SITE_BOOKING_LOAD_FAILED_TEXT} />;
  // Another provider's booking, a hold, or none at all.
  if (site.requestedMissing && !niho) notFound();
  return (
    // Keyed by provider: another provider's bookings start from their own list.
    <HostBookings
      key={provider.id}
      bookings={site.bookings}
      experiences={site.experiences}
      today={site.today}
      now={null}
      providerId={linkProviderId}
      providerDataId={provider.id}
      supportPreview={false}
      supportHistoryEnabled={false}
      feeSummaryEnabled={false}
      translateEnabled={false}
      conversations={[]}
      live={{ nextCursor: site.nextCursor, messages: site.messages, preview: site.preview }}
      niho={niho}
    />
  );
}

/**
 * 予約 (#90): the list, one booking (`?booking=`; a sub screen on phones) and what the host
 * can do with it. The filter, the experience and the booking are the screen's own query: the
 * client screen reads them and moves between them without loading this page again.
 *
 * With EXPERIENCE_GUEST_BOOKING_ENABLED (http mode), the OWNER also sees the bookings travelers made on this
 * site (#285 slice 8): in place of the 準備中 screen while NIHO's bookings are not connected, or with NIHO's on
 * one list (#84, mock v2's one list; `?source=site`, which この回 and older links carry, is the same list).
 * Anyone else, or an OWNER the experience DB does not know, keeps NIHO's list (HostLiveBookings). The preview
 * shows synthetic bookings made on this site with `?mock=site-bookings`.
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
  const { nihoUserId, mockScenario } = context.session;
  const site = await loadSiteBookings(provider, nihoUserId, requested, mockScenario);
  if (providerOperationsEnabled()) {
    const niho = { providerId: provider.id, translate: translateRoomsEntry() };
    if (site.status === "live") return <SiteBookings site={site} provider={provider} linkProviderId={linkProviderId} niho={niho} />;
    return <HostLiveBookings key={provider.id} providerId={provider.id} initialBookingId={requested} translate={niho.translate} siteNotice={site.status === "error" ? <SiteBookingsFailed /> : null} />;
  }
  // While NIHO's bookings are not connected, this site's are the list.
  if (site.status !== "closed") return <SiteBookings site={site} provider={provider} linkProviderId={linkProviderId} niho={null} />;
  const { list, requested: opened, experiences, today, now, conversations } = await loadHostBookings(provider, requested);
  if (list.status === "unavailable") return <BookingsUnavailable />;
  // Another provider's booking, or none at all.
  if (opened?.status === "missing") notFound();
  // Keyed by provider: another provider's bookings start from their own list.
  return <HostBookings key={provider.id} bookings={list.bookings} experiences={experiences} today={today} now={now} providerId={linkProviderId} providerDataId={provider.id} supportPreview={isHostMock()} supportHistoryEnabled={isHostSupportHistoryEnabled()} feeSummaryEnabled={isHostFeeSummaryUiEnabled()} translateEnabled={translateRoomsEnabled()} conversations={conversations} />;
}
