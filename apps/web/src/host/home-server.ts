import "server-only";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock } from "@/lib/host/server";
import { actionTime } from "./bookings";
import { todayInJapan } from "./format";
import { loadGuestQuestions } from "./guest-questions-server";
import { loadGuestReviews } from "./guest-reviews-server";
import { liveHomeTodos, type HomePage, type HomePageListing, type HomeTodo, type HomeTodoSource, type LiveHomeSources } from "./home";

/*
 * ホーム's 次にすること in http mode (the preview has its own, console-data.ts): the threads waiting for the OWNER's
 * answer (予約前の質問 and this site's bookings' messages, as メッセージ reads them), the reviews to answer (as レビュー
 * reads them), and with provider pages on, NIHO's drafts to finish and the listings it is checking. Each source
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
type PagesRead = { pages: HomePage[]; listings: Record<string, HomePageListing | null>; failed: boolean };
const NO_PAGES: PagesRead = { pages: [], listings: {}, failed: false };

/** Legacy NIHO pages/listings are outside contract v1 and do not drive Experience public pages. */
async function readPages(): Promise<PagesRead> { return NO_PAGES; }

/** 次にすること for the provider in http mode; empty in the preview. */
export async function loadHomeTodos(provider: HostProvider): Promise<HostHomeTodosLoad> {
  if (isHostMock()) return { todos: [], failed: [] };
  const [questions, reviews, pages] = await Promise.all([
    loadGuestQuestions(provider, null),
    loadGuestReviews(provider),
    readPages(),
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
