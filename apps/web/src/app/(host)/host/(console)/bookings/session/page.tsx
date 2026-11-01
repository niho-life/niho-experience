import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSession } from "@/components/host/HostSession";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, SubPageHead } from "@/components/host/ui";
import { bookingsHref } from "@/host/bookings";
import { hostPageContext, loadHostSession } from "@/host/data";
import { OTA_BOOKING_LOAD_FAILED_TEXT, withOtaGuests } from "@/host/ota-bookings";
import { loadOtaSession, otaBookingsShown, type HostOtaSessionLoad } from "@/host/ota-bookings-server";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";
import { sessionQueryOf } from "@/host/session";
import { SITE_SESSION_LOAD_FAILED_TEXT } from "@/host/site-sessions";
import { loadSiteSession } from "@/host/site-sessions-server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";
import { isHostMock } from "@/lib/host/server";

export const metadata: Metadata = { title: "参加者と出欠" };

type SearchParams = Record<string, string | string[] | undefined>;

const UNAVAILABLE = {
  title: "この画面は準備中です",
  body: "当日の参加者の確認・出欠・この回の中止は、NIHO との接続ができしだいここから行えるようになります。",
};

/**
 * http mode until NIHO's API has the session's guests and attendance (#87; niho-app#19321): the way back and nothing
 * that pretends to work. Also the read failure of this site's bookings (#285 slice 8b).
 */
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
 * only and with the guests' phones (#285 slice 8b), as 予約 chooses between the sources: in place of 準備中 while
 * NIHO's bookings are not connected, or for `?source=site` beside them (ホーム's and 予約's links carry it). With
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
  const { provider, linkProviderId } = context;
  const { nihoUserId, mockScenario } = context.session;
  const otaShown = otaBookingsShown(mockScenario);
  const session = sessionQueryOf(query);
  const besideNiho = providerOperationsEnabled();
  const key = (providerId: string) => `${providerId}/${session?.date}/${session?.start}/${session?.experience}/${session?.offer}`;
  if (!provider) {
    // A product operator (#194 PR B): the session's OTA bookings of their products, read only (出欠 where it is kept).
    const calendar = otaShown ? await resolveCalendarContext(query) : null;
    if (calendar?.choice?.kind !== "OPERATOR") return <HostRegisterPrompt title="予約" />;
    if (!session) notFound();
    const ota = await loadOtaSession(calendar.choice.id, nihoUserId, null, session, mockScenario);
    const backHref = bookingsHref({ providerId: linkProviderId });
    if (ota.status === "error") return <SessionUnavailable backHref={backHref} title="参加者を読み込めませんでした" body={OTA_BOOKING_LOAD_FAILED_TEXT} />;
    const view = ota.status === "live" ? withOtaGuests(null, ota.bookings, session) : null;
    if (!view || ota.status !== "live") notFound();
    return <HostSession key={key(calendar.choice.id)} session={view} now={ota.now} conversations={[]} providerId={linkProviderId} site={{ besideNiho: false, providerId: calendar.choice.id, messages: false, attendance: false }} ota={{ attendance: ota.attendance }} />;
  }
  if (!session) notFound();
  const otaLoad: HostOtaSessionLoad = otaShown ? await loadOtaSession(provider.id, nihoUserId, provider, session, mockScenario) : { status: "closed" };
  const otaGuests = otaLoad.status === "live" ? otaLoad.bookings : [];
  const ota = otaLoad.status === "live" ? { attendance: otaLoad.attendance } : null;
  const otaNow = otaLoad.status === "live" ? otaLoad.now : "";
  if (!besideNiho || [query.source].flat()[0] === "site") {
    const site = await loadSiteSession(provider, nihoUserId, session);
    const backHref = bookingsHref({ providerId: linkProviderId, source: besideNiho ? "site" : null });
    if (site.status === "error") return <SessionUnavailable backHref={backHref} title="参加者を読み込めませんでした" body={SITE_SESSION_LOAD_FAILED_TEXT} />;
    if (site.status === "live") {
      // With the session's OTA bookings (#194); another provider's session, or none of the bookings at all, is not here.
      const view = withOtaGuests(site.session, otaGuests, session);
      if (!view) notFound();
      return (
        <HostSession
          key={key(provider.id)}
          session={view}
          now={site.now}
          conversations={[]}
          providerId={linkProviderId}
          site={{ besideNiho, providerId: provider.id, messages: site.messages, attendance: site.attendance }}
          ota={ota}
        />
      );
    }
    // This site's bookings are not here: a session of OTA bookings only (#194) still has its guests.
    if (otaGuests.length && !isHostMock()) {
      return <HostSession key={key(provider.id)} session={withOtaGuests(null, otaGuests, session)!} now={otaNow} conversations={[]} providerId={linkProviderId} site={{ besideNiho, providerId: provider.id, messages: false, attendance: false }} ota={ota} />;
    }
  }
  const { lookup, now, conversations } = await loadHostSession(provider, session);
  if (lookup.status === "unavailable") {
    if (otaGuests.length) return <HostSession key={key(provider.id)} session={withOtaGuests(null, otaGuests, session)!} now={otaNow} conversations={[]} providerId={linkProviderId} site={{ besideNiho, providerId: provider.id, messages: false, attendance: false }} ota={ota} />;
    return <SessionUnavailable backHref={bookingsHref({ providerId: linkProviderId })} />;
  }
  // The preview's session with its synthetic OTA guests (`?mock=ota-bookings`); another provider's session, or none at all, is not here.
  const view = withOtaGuests(lookup.status === "ready" ? lookup.session : null, otaGuests, session);
  if (!view) notFound();
  // Keyed by provider and session: another one starts from its own bookings.
  return <HostSession key={key(provider.id)} session={view} now={now} conversations={conversations} providerId={linkProviderId} ota={ota} />;
}
