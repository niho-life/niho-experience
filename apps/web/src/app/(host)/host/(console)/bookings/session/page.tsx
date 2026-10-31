import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSession } from "@/components/host/HostSession";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, SubPageHead } from "@/components/host/ui";
import { bookingsHref } from "@/host/bookings";
import { hostPageContext, loadHostSession } from "@/host/data";
import { sessionQueryOf } from "@/host/session";
import { SITE_SESSION_LOAD_FAILED_TEXT } from "@/host/site-sessions";
import { loadSiteSession } from "@/host/site-sessions-server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";

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
 * NIHO's bookings are not connected, or for `?source=site` beside them (ホーム's and 予約's links carry it).
 */
export default async function HostSessionPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="予約" />;
  const session = sessionQueryOf(query);
  if (!session) notFound();
  const besideNiho = providerOperationsEnabled();
  if (!besideNiho || [query.source].flat()[0] === "site") {
    const site = await loadSiteSession(provider, context.session.nihoUserId, session);
    const backHref = bookingsHref({ providerId: linkProviderId, source: besideNiho ? "site" : null });
    if (site.status === "error") return <SessionUnavailable backHref={backHref} title="参加者を読み込めませんでした" body={SITE_SESSION_LOAD_FAILED_TEXT} />;
    if (site.status === "live") {
      // Another provider's session, or none of this site's bookings at all.
      if (!site.session) notFound();
      return (
        <HostSession
          key={`${provider.id}/${session.date}/${session.start}/${session.experience}/${session.offer}`}
          session={site.session}
          now={site.now}
          conversations={[]}
          providerId={linkProviderId}
          site={{ besideNiho, providerId: provider.id }}
        />
      );
    }
  }
  const { lookup, now, conversations } = await loadHostSession(provider, session);
  if (lookup.status === "unavailable") return <SessionUnavailable backHref={bookingsHref({ providerId: linkProviderId })} />;
  // Another provider's session, or none at all.
  if (lookup.status === "missing") notFound();
  // Keyed by provider and session: another one starts from its own bookings.
  return <HostSession key={`${provider.id}/${session.date}/${session.start}/${session.experience}/${session.offer}`} session={lookup.session} now={now} conversations={conversations} providerId={linkProviderId} />;
}
