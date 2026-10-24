import { describe, expect, it } from "vitest";
import { MOCK_KITCHEN_BOOKINGS, MOCK_NOW, MOCK_TODAY } from "./mock/bookings";
import { MOCK_KITCHEN_REVIEWS, MOCK_REVIEW_REPLY_EXAMPLES, mockReviewEnglishDraft } from "./mock/reviews";
import { PREVIEW_ENGLISH_DRAFT } from "./mock/threads";
import {
  experienceRating,
  publishReviewReply,
  ratingLabel,
  ratingStars,
  replyDates,
  replyDraftFrom,
  reportReview,
  REVIEW_SITE_AVERAGE_TEXT,
  REVIEW_TAGS,
  reviewerLabel,
  reviewIdFromHash,
  reviewReplyDraftState,
  reviewReplyStage,
  reviewSessionLabel,
  reviewsHref,
  reviewsOf,
  reviewsToAttend,
  reviewSummary,
  reviewSummaryNotes,
  reviewTagLabels,
  sortReviews,
} from "./reviews";
import { countryLabel } from "./session";
import type { HostReview } from "./types";

const byId = (id: string): HostReview => MOCK_KITCHEN_REVIEWS.find((review) => review.id === id)!;
const oliver = byId("rv-5020");
const yuki = byId("rv-5013");
const grace = byId("rv-4912");
const AT = MOCK_NOW;

describe("the reviews' summary", () => {
  it("averages the published reviews only, to one decimal, and counts the ones NIHO is checking apart", () => {
    expect(reviewSummary(MOCK_KITCHEN_REVIEWS)).toEqual({ published: 5, pending: 1, average: "4.8", onSite: true });
    expect(reviewSummaryNotes(reviewSummary(MOCK_KITCHEN_REVIEWS))).toEqual(["公開前 1 件"]);
    // 4, 5, 5 → 4.666… → 4.7; the stars are whole numbers from 1 to 5 whatever came.
    expect(reviewSummary([{ status: "published", rating: 4 }, { status: "published", rating: 5 }, { status: "published", rating: 5 }]).average).toBe("4.7");
    expect(reviewSummary([{ status: "published", rating: 9 }, { status: "published", rating: 0 }]).average).toBe("3.0");
  });

  it("says the experience site waits for three published reviews, and says nothing without reviews", () => {
    const two = reviewSummary([oliver, grace, yuki]);
    expect(two).toEqual({ published: 2, pending: 1, average: "5.0", onSite: false });
    expect(reviewSummaryNotes(two)).toEqual(["公開前 1 件", REVIEW_SITE_AVERAGE_TEXT]);
    expect(REVIEW_SITE_AVERAGE_TEXT).toBe("体験サイトでは 3 件から平均を出します");
    // Only one NIHO is checking: no average yet, and the site's rule still applies.
    expect(reviewSummary([yuki])).toEqual({ published: 0, pending: 1, average: null, onSite: false });
    expect(reviewSummaryNotes(reviewSummary([yuki]))).toEqual(["公開前 1 件", REVIEW_SITE_AVERAGE_TEXT]);
    expect(reviewSummaryNotes(reviewSummary([]))).toEqual([]);
  });

  it("gives 体験 each experience's published average and count, or nothing", () => {
    expect(experienceRating(MOCK_KITCHEN_REVIEWS, "community-dinner")).toEqual({ average: "4.8", count: 5 });
    expect(experienceRating(MOCK_KITCHEN_REVIEWS, "kintsugi")).toBeNull();
    expect(experienceRating([yuki], "community-dinner")).toBeNull();
  });
});

describe("the reviews' list", () => {
  it("puts the newest first and narrows to one experience", () => {
    expect(sortReviews(MOCK_KITCHEN_REVIEWS).map((review) => review.id)).toEqual(["rv-5013", "rv-5020", "rv-4926", "rv-4912", "rv-4906", "rv-4902"]);
    expect(reviewsOf(MOCK_KITCHEN_REVIEWS, "community-dinner")).toHaveLength(6);
    expect(reviewsOf(MOCK_KITCHEN_REVIEWS, "kintsugi")).toEqual([]);
    expect(reviewsOf(MOCK_KITCHEN_REVIEWS, null)).toHaveLength(6);
  });

  it("names the reviewer, the session and the stars in words", () => {
    expect(reviewerLabel(oliver)).toBe("Oliver さん · イギリス");
    expect(reviewerLabel({ reviewer: { name: "Ana", country: "" } })).toBe("Ana さん");
    expect(reviewSessionLabel(oliver, "Kamakura Community Dinner with Locals")).toBe("10/17（土）Kamakura Community Dinner with Locals");
    expect(ratingStars(4)).toEqual({ filled: "★★★★", empty: "☆" });
    expect(ratingStars(5)).toEqual({ filled: "★★★★★", empty: "" });
    expect([ratingLabel(5), ratingLabel(4)]).toEqual(["5 点中 5 点", "5 点中 4 点"]);
  });

  it("keeps よかった点 as identifiers and shows them in the host's words, in the choices' order", () => {
    expect(REVIEW_TAGS.map((choice) => choice.value)).toEqual(["CALM_ATMOSPHERE", "GOOD_FOR_BEGINNERS", "EASY_TO_FIND", "GREAT_HOST", "GOOD_VALUE"]);
    expect(reviewTagLabels(oliver.tags)).toEqual(["初めてでも安心", "すてきなホスト", "値段に見合う"]);
    expect(reviewTagLabels(["GOOD_VALUE", "CALM_ATMOSPHERE"])).toEqual(["落ち着いた雰囲気", "値段に見合う"]);
    // An identifier the screen does not know yet is left out, not shown raw.
    expect(reviewTagLabels(["GOOD_VALUE", "FRIENDLY_LOCALS"])).toEqual(["値段に見合う"]);
    expect(reviewTagLabels([])).toEqual([]);
  });

  it("leads to the screen, one experience, or one review (#review-{id}) and reads the hash back", () => {
    expect(reviewsHref()).toBe("/host/reviews");
    expect(reviewsHref({ providerId: "sample-provider-kitchen", experience: "community-dinner" })).toBe("/host/reviews?providerId=sample-provider-kitchen&experience=community-dinner");
    expect(reviewsHref({ review: "rv-5020" })).toBe("/host/reviews#review-rv-5020");
    expect(reviewsHref({ review: "a b" })).toBe("/host/reviews#review-a%20b");
    expect([reviewIdFromHash("#review-rv-5020"), reviewIdFromHash("#review-a%20b"), reviewIdFromHash("#todo"), reviewIdFromHash(""), reviewIdFromHash("#review-%E0")]).toEqual(["rv-5020", "a b", null, null, null]);
  });
});

describe("replies and reports", () => {
  it("lets the host reply once NIHO has published the review, and correct the reply after", () => {
    expect([reviewReplyStage(yuki), reviewReplyStage(oliver), reviewReplyStage(grace)]).toEqual(["waiting", "open", "replied"]);
  });

  it("publishes the first reply, then dates each correction and keeps the first publication", () => {
    const replied = publishReviewReply(oliver, { japanese: " ありがとうございました。 ", english: " Thank you! " }, AT);
    expect(replied.reply).toEqual({ japanese: "ありがとうございました。", english: "Thank you!", publishedAt: AT, editedAt: null });
    const corrected = publishReviewReply(replied, { japanese: "ありがとうございました！", english: "Thank you so much!" }, "2026-10-22T09:00");
    expect(corrected.reply).toEqual({ japanese: "ありがとうございました！", english: "Thank you so much!", publishedAt: AT, editedAt: "2026-10-22T09:00" });
    expect(replyDates(corrected.reply!)).toEqual({ published: "10月21日に公開", edited: "10月22日に直しました" });
    expect(replyDates(replied.reply!)).toEqual({ published: "10月21日に公開", edited: null });
    // Nothing without English, without a change, or before NIHO publishes the review.
    expect(publishReviewReply(oliver, { japanese: "はい", english: " " }, AT)).toBe(oliver);
    expect(publishReviewReply(corrected, { japanese: "ありがとうございました！", english: "Thank you so much!" }, AT)).toBe(corrected);
    expect(publishReviewReply(yuki, { japanese: "はい", english: "Yes" }, AT)).toBe(yuki);
  });

  it("asks for the English again after the Japanese changes, and for a change before a correction is published", () => {
    const fresh = { japanese: "ありがとう", english: "Thank you", madeFrom: "ありがとう" };
    expect(reviewReplyDraftState(fresh, null)).toEqual({ stale: false, canSend: true, unchanged: false });
    expect(reviewReplyDraftState({ ...fresh, japanese: "ありがとう！" }, null)).toEqual({ stale: true, canSend: false, unchanged: false });
    expect(reviewReplyDraftState({ ...fresh, english: "" }, null)).toEqual({ stale: false, canSend: false, unchanged: false });
    // 返信を直す starts from the published reply: unchanged, it publishes nothing; a new Japanese wants new English.
    const start = replyDraftFrom(grace.reply!);
    expect(start).toEqual({ japanese: grace.reply!.japanese, english: grace.reply!.english, madeFrom: grace.reply!.japanese });
    expect(reviewReplyDraftState(start, grace.reply)).toEqual({ stale: false, canSend: false, unchanged: true });
    expect(reviewReplyDraftState({ ...start, japanese: `${start.japanese}またね。` }, grace.reply)).toMatchObject({ stale: true, canSend: false });
    expect(reviewReplyDraftState({ ...start, english: `${start.english} See you!`, madeFrom: null }, grace.reply)).toEqual({ stale: false, canSend: true, unchanged: false });
    // A reply written in English directly stays the host's own English.
    expect(replyDraftFrom({ japanese: "", english: "Thanks!" }).madeFrom).toBeNull();
  });

  it("reports a review once; it stays as it is", () => {
    const reported = reportReview(oliver, "personal", AT);
    expect(reported).toEqual({ ...oliver, report: { at: AT, reason: "personal" } });
    expect(reportReview(reported, "other", "2026-10-22T09:00")).toBe(reported);
    expect(reportReview(yuki, "untrue", AT).status).toBe("pending");
    expect(reportReview(oliver, "other", AT, "  当日の内容が違います。  ").report).toEqual({ at: AT, reason: "other", note: "当日の内容が違います。" });
  });

  it("brings the published reviews without a reply to ホーム first, then the ones NIHO is checking", () => {
    expect(reviewsToAttend(MOCK_KITCHEN_REVIEWS).map((review) => review.id)).toEqual(["rv-5020", "rv-4906", "rv-5013"]);
  });
});

describe("the preview's reviews", () => {
  it("are each for a past booking the guest came to, one per booking, on its day and after it", () => {
    const booked = new Set<string>();
    for (const review of MOCK_KITCHEN_REVIEWS) {
      const booking = MOCK_KITCHEN_BOOKINGS.find((candidate) => candidate.id === review.bookingId);
      expect(booking, review.id).toBeDefined();
      expect([booking!.status, booking!.attendance, booking!.experienceId, booking!.date], review.id).toEqual(["confirmed", "attended", review.experienceId, review.sessionDate]);
      expect(booking!.guest.split(" "), review.id).toContain(review.reviewer.name);
      expect(countryLabel(booking!.country!), review.id).toBe(review.reviewer.country);
      expect(review.sessionDate < MOCK_TODAY && review.writtenAt.slice(0, 10) > review.sessionDate && review.writtenAt < MOCK_NOW, review.id).toBe(true);
      expect(booked.has(review.bookingId), review.id).toBe(false);
      booked.add(review.bookingId);
      expect(review.tags.length > 0 && review.tags.every((tag) => REVIEW_TAGS.some((choice) => choice.value === tag)), review.id).toBe(true);
      expect(review.status === "published" ? review.publishedAt !== null && review.publishedAt > review.writtenAt : review.publishedAt === null && review.reply === null, review.id).toBe(true);
    }
    // No review from a guest who did not come.
    const noShows = MOCK_KITCHEN_BOOKINGS.filter((booking) => booking.attendance === "no_show").map((booking) => booking.id);
    expect(noShows).toEqual(["bk-2010"]);
    expect(MOCK_KITCHEN_REVIEWS.some((review) => noShows.includes(review.bookingId))).toBe(false);
  });

  it("answer 英語にする with the example's English, else a preview sentence", () => {
    const example = MOCK_REVIEW_REPLY_EXAMPLES[0]!;
    expect(mockReviewEnglishDraft(example.reviewId, ` ${example.japanese} `)).toBe(example.english);
    expect(mockReviewEnglishDraft(example.reviewId, "はい")).toBe(PREVIEW_ENGLISH_DRAFT);
    expect(mockReviewEnglishDraft("rv-4906", example.japanese)).toBe(PREVIEW_ENGLISH_DRAFT);
  });
});
