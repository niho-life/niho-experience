import type { Metadata } from "next";
import type { ReactElement } from "react";
import { notFound } from "next/navigation";
import { HostBookings } from "@/components/host/HostBookings";
import { HostLiveBookings } from "@/components/host/HostLiveBookings";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import type { BookingExperience } from "@/host/bookings";
import { hostPageContext, loadHostBookings } from "@/host/data";
import { OTA_BOOKING_LOAD_FAILED_TEXT } from "@/host/ota-bookings";
import { loadOtaBookings, otaBookingsShown, type HostOtaBookingsLoad } from "@/host/ota-bookings-server";
import type { HostBooking } from "@/host/types";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "@/host/site-bookings";
import { loadSiteBookings, type HostSiteBookingsLoad } from "@/host/site-bookings-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock } from "@/lib/host/server";
import { isHostSupportHistoryEnabled } from "@/lib/host/support-history-server";
import { isHostFeeSummaryUiEnabled } from "@/lib/host/fee-summary-server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";
import { translateRoomsEnabled, translateRoomsEntry } from "@/lib/host/translate-rooms-server";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";

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
type OtaRows = { bookings: readonly HostBooking[]; experiences: readonly BookingExperience[] } | null;

/** The OTA bookings (#194 PR B) the list puts beside the others, or null while they are not shown or could not be read. */
function otaRows(load: HostOtaBookingsLoad): OtaRows {
  return load.status === "live" ? { bookings: load.bookings, experiences: load.experiences } : null;
}

/** The list as it is, or with a line above it. */
function withNotice(notice: ReactElement | null, list: ReactElement): ReactElement {
  return notice ? <>{notice}{list}</> : list;
}

/** Above the list when the OTA bookings could not be read beside the others. */
function OtaBookingsFailed() {
  return (
    <p role="alert" className="mx-auto mb-3.5 max-w-5xl rounded-xl bg-danger-pale p-3 text-sm font-bold text-danger">
      {OTA_BOOKING_LOAD_FAILED_TEXT}
    </p>
  );
}

/**
 * 予約 with only bookings made on reservation sites (#194 PR B): a product operator's (their products' only), or an OWNER's
 * while neither this site's nor NIHO's bookings are here. Read only.
 */
function OtaOnlyBookings({ ota, providerDataId, linkProviderId, today }: { ota: NonNullable<OtaRows>; providerDataId: string; linkProviderId: string | null; today: string }) {
  return (
    <HostBookings
      key={providerDataId}
      bookings={[]}
      experiences={[]}
      today={today}
      now={null}
      providerId={linkProviderId}
      providerDataId={providerDataId}
      supportPreview={false}
      supportHistoryEnabled={false}
      feeSummaryEnabled={false}
      translateEnabled={false}
      conversations={[]}
      ota={ota}
    />
  );
}

function SiteBookings({ site, provider, linkProviderId, niho, ota }: { site: Exclude<HostSiteBookingsLoad, { status: "closed" }>; provider: HostProvider; linkProviderId: string | null; niho: { providerId: string; translate: { today: string } | null } | null; ota: OtaRows }) {
  if (site.status === "error") return <BookingsUnavailable title="予約を読み込めませんでした" body={SITE_BOOKING_LOAD_FAILED_TEXT} />;
  // Another provider's booking, a hold, or none at all (nor an OTA booking of theirs).
  if (site.requestedMissing && !niho && !ota?.bookings.length) notFound();
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
      ota={ota}
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
 *
 * With EXPERIENCE_OTA_GUEST_DETAILS_ENABLED (#194 PR B), the bookings made on reservation sites join whichever list it is,
 * with their site's badge and a read-only detail (`?ota=` is the push's link); a product operator sees those of their
 * products only, as the whole screen. The preview shows synthetic ones with `?mock=ota-bookings`.
 */
export default async function HostBookingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId, providerNotFound } = context;
  // The first `?booking=`, as the screen reads it, or the push's `?ota=` (#194).
  const requested = [query.booking].flat()[0] || [query.ota].flat()[0] || null;
  const { mockScenario } = context.session;
  // A product operator (#194 PR B): with no provider of NIHO's, or naming one only their grant gives (NIHO's list would
  // fall back to another provider of theirs). The same choice as the console's frame (resolveCalendarContext).
  const calendar = (!provider || providerNotFound) && otaBookingsShown(mockScenario) ? await resolveCalendarContext(query) : null;
  if (calendar?.choice?.kind === "OPERATOR" || !provider) {
    // The OTA bookings of their products, read only.
    if (calendar?.choice?.kind !== "OPERATOR") return <HostRegisterPrompt title="予約" />;
    const load = await loadOtaBookings(calendar.choice.id, null, requested, mockScenario);
    if (load.status === "error") return <BookingsUnavailable title="予約を読み込めませんでした" body={OTA_BOOKING_LOAD_FAILED_TEXT} />;
    if (load.status !== "live") return <HostRegisterPrompt title="予約" />;
    return <OtaOnlyBookings ota={otaRows(load)!} providerDataId={calendar.choice.id} linkProviderId={linkProviderId} today={load.today} />;
  }
  if (provider.memberRole === "EDITOR") notFound();
  const [site, otaLoad] = await Promise.all([
    loadSiteBookings(provider, requested, mockScenario),
    loadOtaBookings(provider.id, provider, requested, mockScenario),
  ]);
  const ota = otaRows(otaLoad);
  const otaFailed = otaLoad.status === "error" ? <OtaBookingsFailed /> : null;
  if (providerOperationsEnabled()) {
    const niho = { providerId: provider.id, translate: translateRoomsEntry() };
    if (site.status === "live") return withNotice(otaFailed, <SiteBookings site={site} provider={provider} linkProviderId={linkProviderId} niho={niho} ota={ota} />);
    // NIHO's bookings and the OTA ones on one list (#194), when there are OTA bookings to show.
    if (ota && otaLoad.status === "live" && site.status === "closed") {
      return <HostBookings key={provider.id} bookings={[]} experiences={[]} today={otaLoad.today} now={null} providerId={linkProviderId} providerDataId={provider.id} supportPreview={false} supportHistoryEnabled={isHostSupportHistoryEnabled()} feeSummaryEnabled={isHostFeeSummaryUiEnabled()} translateEnabled={translateRoomsEnabled()} conversations={[]} niho={niho} ota={ota} />;
    }
    return withNotice(otaFailed, <HostLiveBookings key={provider.id} providerId={provider.id} initialBookingId={requested} translate={niho.translate} siteNotice={site.status === "error" ? <SiteBookingsFailed /> : null} />);
  }
  // While NIHO's bookings are not connected, this site's are the list.
  if (site.status !== "closed") return withNotice(otaFailed, <SiteBookings site={site} provider={provider} linkProviderId={linkProviderId} niho={null} ota={ota} />);
  const { list, requested: opened, experiences, today, now, conversations } = await loadHostBookings(provider, requested);
  if (list.status === "unavailable") {
    // Only OTA bookings are here (#194): they are the list.
    if (ota && otaLoad.status === "live") return <OtaOnlyBookings ota={ota} providerDataId={provider.id} linkProviderId={linkProviderId} today={otaLoad.today} />;
    return <BookingsUnavailable />;
  }
  // Another provider's booking, or none at all (nor an OTA booking of theirs).
  if (opened?.status === "missing" && !ota?.bookings.some((booking) => booking.id === requested?.toLowerCase())) notFound();
  // Keyed by provider: another provider's bookings start from their own list.
  return withNotice(otaFailed, <HostBookings key={provider.id} bookings={list.bookings} experiences={experiences} today={today} now={now} providerId={linkProviderId} providerDataId={provider.id} supportPreview={isHostMock()} supportHistoryEnabled={isHostSupportHistoryEnabled()} feeSummaryEnabled={isHostFeeSummaryUiEnabled()} translateEnabled={translateRoomsEnabled()} conversations={conversations} ota={ota} />);
}
