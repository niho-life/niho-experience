import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostMessages } from "@/components/host/HostMessages";
import { HostLiveBookings } from "@/components/host/HostLiveBookings";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostMessages } from "@/host/data";
import { HOST_HOME_PATH, withProvider } from "@/lib/host/routes";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";

export const metadata: Metadata = { title: "メッセージ" };

type SearchParams = Record<string, string | string[] | undefined>;

/** HTTP rollout gate while the provider booking conversation contract is disabled. */
function MessagesUnavailable({ homeHref }: { homeHref: string }) {
  return (
    <>
      <HostSubHeader backHref={homeHref} backLabel="ホーム" title="" />
      <HostPageBody>
        <PageHead title="メッセージ" />
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">この画面は準備中です</p>
          <p className="mt-1 text-ink-soft">予約後のWeb返信と予約者への個別連絡は、NIHO との接続を有効にしたあと、ここから読み書きできます。予約前の質問はまだ利用できません。</p>
        </section>
      </HostPageBody>
    </>
  );
}

/**
 * メッセージ (#106): every thread with the provider's guests, and one of them (`?thread=`, or a
 * booking's: `?booking=`, an empty one to start when it has none). A screen under ホーム: the
 * menu keeps ホーム selected, phones go back with "‹ ホーム". The client screen reads the thread
 * from the query and moves between threads without loading this page again.
 */
export default async function HostMessagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="メッセージ" />;
  if (provider.memberRole === "EDITOR") notFound();
  // The first `?thread=` (or `?booking=`), as the screen reads it.
  const thread = [query.thread].flat()[0] || null;
  const booking = [query.booking].flat()[0] || null;
  const homeHref = withProvider(HOST_HOME_PATH, linkProviderId);
  if (providerOperationsEnabled()) return <><HostSubHeader backHref={homeHref} backLabel="ホーム" title="" /><HostLiveBookings key={`${provider.id}/messages`} providerId={provider.id} initialBookingId={booking} mode="messages" /></>;
  const { list, requested, experiences, today, now } = await loadHostMessages(provider, { thread, booking });
  if (list.status === "unavailable") return <MessagesUnavailable homeHref={homeHref} />;
  // Another provider's thread or booking, a booking that can no longer be written to, or none at all.
  if (requested?.status === "missing") notFound();
  return (
    // Keyed by provider: another provider's threads start from their own list.
    <HostMessages
      key={provider.id}
      threads={list.threads}
      newThread={requested?.status === "new" ? requested.thread : null}
      experiences={experiences}
      today={today}
      now={now}
      linkProviderId={linkProviderId}
      providerId={provider.id}
      providerName={provider.displayName}
    />
  );
}
