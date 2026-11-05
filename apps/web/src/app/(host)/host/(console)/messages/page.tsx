import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostMessages } from "@/components/host/HostMessages";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext } from "@/host/data";
import { GUEST_QUESTION_LOAD_FAILED_TEXT, loadGuestQuestions, type HostGuestQuestionsLoad } from "@/host/guest-questions-server";
import type { HostProvider } from "@/lib/host/providers";
import { HOST_HOME_PATH, withProvider } from "@/lib/host/routes";

export const metadata: Metadata = { title: "メッセージ" };

type SearchParams = Record<string, string | string[] | undefined>;

const UNAVAILABLE = {
  title: "この画面は準備中です",
  body: "Experience のメッセージ接続を有効にすると、予約前の質問とExperience予約の会話をここで確認できます。",
};

/** HTTP rollout gate while the provider booking conversation contract is disabled; also the questions' read failure. */
function MessagesUnavailable({ homeHref, title = UNAVAILABLE.title, body = UNAVAILABLE.body }: { homeHref: string; title?: string; body?: string }) {
  return (
    <>
      <HostSubHeader backHref={homeHref} backLabel="ホーム" title="" />
      <HostPageBody>
        <PageHead title="メッセージ" />
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">{title}</p>
          <p className="mt-1 text-ink-soft">{body}</p>
        </section>
      </HostPageBody>
    </>
  );
}

/** The threads kept in the experience DB (questions, and this site's bookings' messages) as the client screen shows them. */
function SiteThreads({ questions, provider, linkProviderId }: { questions: Extract<HostGuestQuestionsLoad, { status: "live" }>; provider: HostProvider; linkProviderId: string | null }) {
  if (questions.requestedMissing) notFound();
  return (
    <HostMessages
      key={provider.id}
      threads={questions.threads}
      newThread={questions.newThread}
      experiences={questions.experiences}
      today={questions.today}
      now={questions.now}
      linkProviderId={linkProviderId}
      providerId={provider.id}
      providerName={provider.displayName}
      live={{ loaded: questions.loaded, nextCursor: questions.nextCursor }}
    />
  );
}

/**
 * メッセージ (#106): every thread with the provider's guests, and one of them (`?thread=`, or a
 * booking's: `?booking=`, an empty one to start when it has none). A screen under ホーム: the
 * menu keeps ホーム selected, phones go back with "‹ ホーム". The client screen reads the thread
 * from the query and moves between threads without loading this page again.
 *
 * Bookings made on this site (#285 slice 6b) have their threads among the questions (`?booking=` opens one from 予約
 * or この回, empty until the host's first message).
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
  const questions = await loadGuestQuestions(provider, thread, booking);
  if (questions.status === "error") return <MessagesUnavailable homeHref={homeHref} title="メッセージを読み込めませんでした" body={GUEST_QUESTION_LOAD_FAILED_TEXT} />;
  if (questions.status === "closed") return <MessagesUnavailable homeHref={homeHref} />;
  return <SiteThreads questions={questions} provider={provider} linkProviderId={linkProviderId} />;
}
