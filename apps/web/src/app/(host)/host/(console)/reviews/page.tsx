import type { Metadata } from "next";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostReviews } from "@/components/host/HostReviews";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostReviews } from "@/host/data";
import { HOST_HOME_PATH, withProvider } from "@/lib/host/routes";

export const metadata: Metadata = { title: "レビュー" };

type SearchParams = Record<string, string | string[] | undefined>;

/** http mode until NIHO's API has the reviews (#87; niho-app#19314): nothing that pretends to work. */
function ReviewsUnavailable({ homeHref }: { homeHref: string }) {
  return (
    <>
      <HostSubHeader backHref={homeHref} backLabel="ホーム" title="" />
      <HostPageBody>
        <PageHead title="レビュー" />
        <section className={`${HOST_SURFACE} px-5 py-8 md:px-6 md:py-10`}>
          <p className="font-extrabold">この画面は準備中です</p>
          <p className="mt-1 text-ink-soft">予約者のレビューは、NIHO との接続ができしだいここで読み、返信できるようになります。</p>
        </section>
      </HostPageBody>
    </>
  );
}

/**
 * レビュー (#108): every review of the provider's experiences, published or still checked by NIHO,
 * with the replies and reports. A screen under ホーム: the menu keeps ホーム selected, phones go
 * back with "‹ ホーム". The client screen reads `?experience=` and `#review-{id}` itself.
 */
export default async function HostReviewsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await hostPageContext(await searchParams);
  // The console layout shows sign-in, refresh and error states.
  if (!context) return null;
  const { provider, linkProviderId } = context;
  if (!provider) return <HostRegisterPrompt title="レビュー" />;
  const { list, experiences, now } = loadHostReviews(provider);
  if (list.status === "unavailable") return <ReviewsUnavailable homeHref={withProvider(HOST_HOME_PATH, linkProviderId)} />;
  return (
    // Keyed by provider: another provider's reviews start from their own list.
    <HostReviews key={provider.id} reviews={list.reviews} experiences={experiences} now={now} linkProviderId={linkProviderId} providerId={provider.id} />
  );
}
