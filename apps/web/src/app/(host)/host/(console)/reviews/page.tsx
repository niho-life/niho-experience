import type { Metadata } from "next";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostReviews } from "@/components/host/HostReviews";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostReviews } from "@/host/data";
import { GUEST_REVIEW_LOAD_FAILED_TEXT, GUEST_REVIEW_OWNER_ONLY_TEXT, loadGuestReviews } from "@/host/guest-reviews-server";
import { HOST_HOME_PATH, withProvider } from "@/lib/host/routes";

export const metadata: Metadata = { title: "レビュー" };

type SearchParams = Record<string, string | string[] | undefined>;

const UNAVAILABLE = {
  title: "この画面は準備中です",
  body: "予約者のレビューは、NIHO との接続ができしだいここで読み、返信できるようになります。",
};

/** http mode until NIHO's API has the reviews (#87; niho-app#19314): nothing that pretends to work; also the live reviews' read failure. */
function ReviewsUnavailable({ homeHref, title = UNAVAILABLE.title, body = UNAVAILABLE.body }: { homeHref: string; title?: string; body?: string }) {
  return (
    <>
      <HostSubHeader backHref={homeHref} backLabel="ホーム" title="" />
      <HostPageBody>
        <PageHead title="レビュー" />
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">{title}</p>
          <p className="mt-1 text-ink-soft">{body}</p>
        </section>
      </HostPageBody>
    </>
  );
}

/**
 * レビュー (#108): every review of the provider's experiences (each published when written), with the
 * replies and reports. A screen under ホーム: the menu keeps ホーム selected, phones go
 * back with "‹ ホーム". The client screen reads `?experience=` and `#review-{id}` itself.
 */
export default async function HostReviewsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await hostPageContext(await searchParams);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="レビュー" />;
  const homeHref = withProvider(HOST_HOME_PATH, linkProviderId);
  // 予約者のレビュー kept in the experience DB (#108): the OWNER's reviews, each shown (and open to a reply) from when it was written, a page at a time. While closed, the screen below.
  const live = await loadGuestReviews(provider, context.session.nihoUserId);
  if (live.status === "live") {
    return (
      <HostReviews
        key={provider.id}
        reviews={live.reviews}
        experiences={live.experiences}
        now={live.now}
        linkProviderId={linkProviderId}
        providerId={provider.id}
        live={{ revisions: live.revisions, nextCursor: live.nextCursor, counts: live.counts }}
      />
    );
  }
  if (live.status === "error") return <ReviewsUnavailable homeHref={homeHref} title="レビューを読み込めませんでした" body={GUEST_REVIEW_LOAD_FAILED_TEXT} />;
  if (live.status === "owner-only") return <ReviewsUnavailable homeHref={homeHref} title={GUEST_REVIEW_OWNER_ONLY_TEXT} body="オーナーのアカウントでログインすると、レビューを読んで返信できます。" />;
  const { list, experiences, now } = loadHostReviews(provider);
  if (list.status === "unavailable") return <ReviewsUnavailable homeHref={homeHref} />;
  return (
    // Keyed by provider: another provider's reviews start from their own list.
    <HostReviews key={provider.id} reviews={list.reviews} experiences={experiences} now={now} linkProviderId={linkProviderId} providerId={provider.id} />
  );
}
