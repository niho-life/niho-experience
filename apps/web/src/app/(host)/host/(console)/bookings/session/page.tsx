import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSession } from "@/components/host/HostSession";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, SubPageHead } from "@/components/host/ui";
import { bookingsHref } from "@/host/bookings";
import { hostPageContext } from "@/host/data";
import { OTA_BOOKING_LOAD_FAILED_TEXT, withOtaGuests } from "@/host/ota-bookings";
import { loadOtaSession, otaBookingsShown, type HostOtaSessionLoad } from "@/host/ota-bookings-server";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";
import { sessionQueryOf } from "@/host/session";
import { SITE_SESSION_LOAD_FAILED_TEXT } from "@/host/site-sessions";
import { loadSiteSession } from "@/host/site-sessions-server";

export const metadata: Metadata = { title: "参加者と出欠" };

type SearchParams = Record<string, string | string[] | undefined>;

const UNAVAILABLE = {
  title: "この画面は準備中です",
  body: "Experience の予約管理を有効にすると、当日の参加者をここで確認できます。",
};

/** The way back and a clear message while Experience's bookings are unavailable. */
function SessionUnavailable({ backHref, title = UNAVAILABLE.title, body = UNAVAILABLE.body }: { backHref: string; title?: string; body?: string }) {
  return (
    <>
      <HostSubHeader backHref={backHref} backLabel="予約" title="参加者と出欠" />
      <HostPageBody>
        <SubPageHead backHref={backHref} backLabel="予約" title="参加者と出欠" />
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">{title}</p>
          <p className="mt-1 text-ink-soft">{body}</p>
        </section>
      </HostPageBody>
    </>
  );
}

/**
 * この回 (#107): one session's guests and attendance on the day, under 予約: the menu keeps 予約
 * selected and phones go back with "‹ 予約" (no bottom tabs). `?date=&start=&experience=&offer=`
 * name the session; one without a booking of the provider's does not exist here.
 *
 * With EXPERIENCE_GUEST_BOOKING_ENABLED (http mode), the OWNER sees the session's bookings made on this site, read
 * only and with the guests' phones (#285 slice 8b). With
 * EXPERIENCE_HOST_ATTENDANCE_ENABLED as well, the session's capacity and 来た / 来なかった kept in the experience DB (#107).
 *
 * With EXPERIENCE_OTA_GUEST_DETAILS_ENABLED (#194 PR B), the session's bookings made on reservation sites join its guests,
 * with their site's badge and phone, and 出欠 where it is kept (0039); a product operator sees them for their products only.
 * The preview shows synthetic ones with `?mock=ota-bookings`.
 */
export default async function HostSessionPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId, providerNotFound } = context;
  const { mockScenario } = context.session;
  const otaShown = otaBookingsShown(mockScenario);
  const session = sessionQueryOf(query);
  const key = (providerId: string) => `${providerId}/${session?.date}/${session?.start}/${session?.experience}/${session?.offer}`;
  // A product operator (#194 PR B): with no provider of NIHO's, or naming one only their grant gives (NIHO's list would
  // fall back to another provider of theirs). The same choice as the console's frame.
  const calendar = (!provider || providerNotFound) && otaShown ? await resolveCalendarContext(query) : null;
  if (calendar?.choice?.kind === "OPERATOR" || !provider) {
    // The session's OTA bookings of their products, read only (出欠 where it is kept).
    if (calendar?.choice?.kind !== "OPERATOR") return <HostRegisterPrompt title="予約" />;
    if (!session) notFound();
    const ota = await loadOtaSession(calendar.choice.id, null, session, mockScenario);
    const backHref = bookingsHref({ providerId: linkProviderId });
    if (ota.status === "error") return <SessionUnavailable backHref={backHref} title="参加者を読み込めませんでした" body={OTA_BOOKING_LOAD_FAILED_TEXT} />;
    const view = ota.status === "live" ? withOtaGuests(null, ota.bookings, session) : null;
    if (!view || ota.status !== "live") notFound();
    return <HostSession key={key(calendar.choice.id)} session={view} now={ota.now} providerId={linkProviderId} site={{ providerId: calendar.choice.id, messages: false, attendance: false }} ota={{ attendance: ota.attendance }} />;
  }
  if (provider.memberRole === "EDITOR") notFound();
  if (!session) notFound();
  const otaLoad: HostOtaSessionLoad = otaShown ? await loadOtaSession(provider.id, provider, session, mockScenario) : { status: "closed" };
  const otaGuests = otaLoad.status === "live" ? otaLoad.bookings : [];
  const ota = otaLoad.status === "live" ? { attendance: otaLoad.attendance } : null;
  const otaNow = otaLoad.status === "live" ? otaLoad.now : "";
  const site = await loadSiteSession(provider, session);
  const backHref = bookingsHref({ providerId: linkProviderId });
  if (site.status === "error") return <SessionUnavailable backHref={backHref} title="参加者を読み込めませんでした" body={SITE_SESSION_LOAD_FAILED_TEXT} />;
  if (site.status === "closed" && !otaGuests.length) return <SessionUnavailable backHref={backHref} />;
  const view = withOtaGuests(site.status === "live" ? site.session : null, otaGuests, session);
  if (!view) notFound();
  return (
    <HostSession
      key={key(provider.id)}
      session={view}
      now={site.status === "live" ? site.now : otaNow}
      providerId={linkProviderId}
      site={{ providerId: provider.id, messages: site.status === "live" && site.messages, attendance: site.status === "live" && site.attendance, preview: site.status === "live" ? site.preview : undefined }}
      ota={ota}
    />
  );
}
