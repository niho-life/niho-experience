import type { Metadata } from "next";
import type { ReactElement } from "react";
import { notFound } from "next/navigation";
import { HostBookings } from "@/components/host/HostBookings";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import type { BookingExperience } from "@/host/bookings";
import { hostPageContext } from "@/host/data";
import { OTA_BOOKING_LOAD_FAILED_TEXT } from "@/host/ota-bookings";
import { loadOtaBookings, otaBookingsShown, type HostOtaBookingsLoad } from "@/host/ota-bookings-server";
import type { HostBooking } from "@/host/types";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "@/host/site-bookings";
import { loadSiteBookings, type HostSiteBookingsLoad } from "@/host/site-bookings-server";
import type { HostProvider } from "@/lib/host/providers";
import { translateRoomsEnabled } from "@/lib/host/translate-rooms-server";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";

export const metadata: Metadata = { title: "予約" };

type SearchParams = Record<string, string | string[] | undefined>;

const UNAVAILABLE = {
  title: "この画面は準備中です",
  body: "Experience の予約管理を有効にすると、ここで予約を確認できます。",
};

/** Rollout gate while Experience booking reads are unavailable. */
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

/**
 * Experience bookings (#285 slice 8) and optional read-only OTA bookings.
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
 * 予約 with only bookings made on reservation sites (#194 PR B), for a product operator or while Experience bookings are unavailable. Read only.
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
      ota={ota}
    />
  );
}

function SiteBookings({ site, provider, linkProviderId, requested, ota }: { site: Exclude<HostSiteBookingsLoad, { status: "closed" }>; provider: HostProvider; linkProviderId: string | null; requested: string | null; ota: OtaRows }) {
  if (site.status === "error") return <BookingsUnavailable title="予約を読み込めませんでした" body={SITE_BOOKING_LOAD_FAILED_TEXT} />;
  if (site.requestedMissing && !ota?.bookings.some((booking) => booking.id === requested?.toLowerCase())) notFound();
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
      translateEnabled={translateRoomsEnabled()}
      live={{ nextCursor: site.nextCursor, messages: site.messages, preview: site.preview, readOnly: site.readOnly, canCancel: site.canCancel }}
      ota={ota}
    />
  );
}

/**
 * 予約 (#90): the list, one booking (`?booking=`; a sub screen on phones) and what the host
 * can do with it. The filter, the experience and the booking are the screen's own query: the
 * client screen reads them and moves between them without loading this page again.
 *
 * The OWNER sees bookings made on this site (#285 slice 8). The preview
 * shows synthetic Experience bookings with `?mock=site-bookings`.
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
  // A product operator (#194 PR B): with no provider membership, or naming one only their product grant gives.
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
    loadSiteBookings(provider, requested),
    loadOtaBookings(provider.id, provider, requested, mockScenario),
  ]);
  const ota = otaRows(otaLoad);
  const otaFailed = otaLoad.status === "error" ? <OtaBookingsFailed /> : null;
  if (site.status === "live") return withNotice(otaFailed, <SiteBookings site={site} provider={provider} linkProviderId={linkProviderId} requested={requested} ota={ota} />);
  if (site.status === "closed" && ota && otaLoad.status === "live") return <OtaOnlyBookings ota={ota} providerDataId={provider.id} linkProviderId={linkProviderId} today={otaLoad.today} />;
  if (site.status === "error") return <BookingsUnavailable title="予約を読み込めませんでした" body={SITE_BOOKING_LOAD_FAILED_TEXT} />;
  return withNotice(otaFailed, <BookingsUnavailable />);
}
