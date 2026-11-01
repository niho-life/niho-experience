import "server-only";
import type { ExperienceHostApiClient, ExperienceHostApiFailure } from "@niho-experience/api-client/host";
import type { HostProvider } from "@/lib/host/providers";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";
import { hostApiClient, isHostMock } from "@/lib/host/server";
import { idTokenUsable, type HostSession } from "@/lib/host/session";
import { actionTime } from "./bookings";
import { todayInJapan } from "./format";
import { loadGuestQuestions } from "./guest-questions-server";
import { loadGuestReviews } from "./guest-reviews-server";
import { liveHomeTodos, type HomePage, type HomePageListing, type HomeTodo, type HomeTodoSource, type LiveHomeSources } from "./home";

/*
 * ホーム's 次にすること in http mode (the preview has its own, console-data.ts): the threads waiting for the OWNER's
 * answer (予約前の質問 and this site's bookings' messages, as メッセージ reads them), the reviews to answer (as レビュー
 * reads them), and with provider operations on, NIHO's drafts to finish and the listings it is checking. Each source
 * is read as its own screen does, behind its own flags; one that cannot be read is said once on ホーム and the others
 * still show. This site's payments under review come from site-sessions-server.ts, as before. Nothing here marks a
 * thread read.
 */

export interface HostHomeTodosLoad {
  todos: HomeTodo[];
  /** The sources that could not be read, in the order ホーム names them. */
  failed: HomeTodoSource[];
}

/** NIHO's published pages whose listing is read, at most: ホーム does not wait on a long list. */
const LISTING_READS = 20;

type PagesRead = { pages: HomePage[]; listings: Record<string, HomePageListing | null>; failed: boolean };
const NO_PAGES: PagesRead = { pages: [], listings: {}, failed: false };

/** NIHO no longer lets this account in (sign-in again, or the permission ended): the layout says so, nothing to add. */
const refused = (failure: ExperienceHostApiFailure) => failure.kind === "error" && [401, 403, 404].includes(failure.status);

/** One published page's listing; undefined when it could not be read. */
async function listingOf(client: ExperienceHostApiClient, providerId: string, pageId: string): Promise<HomePageListing | null | undefined> {
  try {
    const result = await client.getExperienceProviderPageListing(providerId, pageId);
    if (!result.ok) return refused(result) ? null : undefined;
    const listing = result.data.listing;
    return listing ? { status: listing.status, consentedAt: listing.consentedAt } : null;
  } catch {
    return undefined;
  }
}

/** NIHO's pages and the listings of the published ones (provider operations on, with a usable ID token). */
async function readPages(provider: HostProvider, session: HostSession): Promise<PagesRead> {
  if (!providerOperationsEnabled() || !idTokenUsable(session, Date.now())) return NO_PAGES;
  try {
    const client = hostApiClient(session);
    const result = await client.listExperienceProviderPages(provider.id);
    if (!result.ok) return refused(result) ? NO_PAGES : { ...NO_PAGES, failed: true };
    const pages: HomePage[] = result.data.pages.map((page) => ({ id: page.id, title: page.title, status: page.status }));
    const published = pages.filter((page) => page.status === "PUBLISHED").slice(0, LISTING_READS);
    const read = await Promise.all(published.map(async (page) => [page.id, await listingOf(client, provider.id, page.id)] as const));
    const listings: Record<string, HomePageListing | null> = {};
    for (const [id, listing] of read) if (listing !== undefined) listings[id] = listing;
    return { pages, listings, failed: read.some(([, listing]) => listing === undefined) };
  } catch {
    return { ...NO_PAGES, failed: true };
  }
}

/** 次にすること for the provider in http mode; empty in the preview. */
export async function loadHomeTodos(provider: HostProvider, session: HostSession): Promise<HostHomeTodosLoad> {
  if (isHostMock()) return { todos: [], failed: [] };
  const [questions, reviews, pages] = await Promise.all([
    loadGuestQuestions(provider, session.nihoUserId, null),
    loadGuestReviews(provider, session.nihoUserId),
    readPages(provider, session),
  ]);
  const now = Date.now();
  const sources: LiveHomeSources = {
    threads: questions.status === "live" ? questions.threads : [],
    reviews: reviews.status === "live" ? reviews.reviews : [],
    reviewExperiences: reviews.status === "live" ? reviews.experiences : [],
    pages: pages.pages,
    listings: pages.listings,
    now: actionTime(todayInJapan(now), now),
  };
  const failed: HomeTodoSource[] = [];
  if (questions.status === "error") failed.push("messages");
  if (reviews.status === "error") failed.push("reviews");
  if (pages.failed) failed.push("experiences");
  return { todos: liveHomeTodos(sources), failed };
}
