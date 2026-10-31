import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HostBookings } from "@/components/host/HostBookings";
import { HostLiveBookings } from "@/components/host/HostLiveBookings";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { bookingsHref } from "@/host/bookings";
import { hostPageContext, loadHostBookings } from "@/host/data";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "@/host/site-bookings";
import { countSiteBookings, loadSiteBookings, type HostSiteBookingsLoad } from "@/host/site-bookings-server";
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

/** Above NIHO's bookings (provider operations): the way to the ones made on this site (#285 slice 8). */
function SiteBookingsNotice({ count, href }: { count: number; href: string }) {
  return (
    <p className="mb-3.5 rounded-xl bg-sand p-3 text-sm">
      <Link href={href} className="font-extrabold text-ink underline underline-offset-2">
        このサイトで受けた予約が {count} 件あります
      </Link>
    </p>
  );
}

/** The bookings made on this site (#285 slice 8, experience DB) in the bookings screen, read only. */
function SiteBookings({ site, provider, linkProviderId, besideNiho }: { site: Exclude<HostSiteBookingsLoad, { status: "closed" }>; provider: HostProvider; linkProviderId: string | null; besideNiho: boolean }) {
  if (site.status === "error") return <BookingsUnavailable title="予約を読み込めませんでした" body={SITE_BOOKING_LOAD_FAILED_TEXT} />;
  // Another provider's booking, a hold, or none at all.
  if (site.requestedMissing) notFound();
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
      live={{ nextCursor: site.nextCursor, besideNiho }}
    />
  );
}

/**
 * 予約 (#90): the list, one booking (`?booking=`; a sub screen on phones) and what the host
 * can do with it. The filter, the experience and the booking are the screen's own query: the
 * client screen reads them and moves between them without loading this page again.
 *
 * With EXPERIENCE_GUEST_BOOKING_ENABLED (http mode), the OWNER also sees the bookings travelers made on this
 * site (#285 slice 8): in place of the 準備中 screen while NIHO's bookings are not connected, or beside
 * NIHO's (a notice above them leads to `?source=site`).
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
  const nihoUserId = context.session.nihoUserId;
  if (providerOperationsEnabled()) {
    if ([query.source].flat()[0] === "site") {
      const site = await loadSiteBookings(provider, nihoUserId, requested);
      if (site.status !== "closed") return <SiteBookings site={site} provider={provider} linkProviderId={linkProviderId} besideNiho />;
    }
    const count = await countSiteBookings(provider, nihoUserId);
    const notice = count > 0 ? <SiteBookingsNotice count={count} href={bookingsHref({ providerId: linkProviderId, source: "site" })} /> : null;
    return <HostLiveBookings key={provider.id} providerId={provider.id} initialBookingId={requested} translate={translateRoomsEntry()} siteNotice={notice} />;
  }
  // While NIHO's bookings are not connected, this site's are the list (TODO(#87): NIHO's beside them).
  const site = await loadSiteBookings(provider, nihoUserId, requested);
  if (site.status !== "closed") return <SiteBookings site={site} provider={provider} linkProviderId={linkProviderId} besideNiho={false} />;
  const { list, requested: opened, experiences, today, now, conversations } = await loadHostBookings(provider, requested);
  if (list.status === "unavailable") return <BookingsUnavailable />;
  // Another provider's booking, or none at all.
  if (opened?.status === "missing") notFound();
  // Keyed by provider: another provider's bookings start from their own list.
  return <HostBookings key={provider.id} bookings={list.bookings} experiences={experiences} today={today} now={now} providerId={linkProviderId} providerDataId={provider.id} supportPreview={isHostMock()} supportHistoryEnabled={isHostSupportHistoryEnabled()} feeSummaryEnabled={isHostFeeSummaryUiEnabled()} translateEnabled={translateRoomsEnabled()} conversations={conversations} />;
}
