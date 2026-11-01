import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError, type HostActor, type HostGuestReview } from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";
import { createTranslator, type Translator } from "@/lib/translation/anthropic";
import { REVIEW_REPLY_TO_ENGLISH_SYSTEM, TRANSLATION_MODEL } from "@/lib/translation/prompts";

/** レビュー's reviews against a stubbed experience store and NIHO provider list (#108). */
const state = vi.hoisted(() => ({
  store: null as null | Record<string, ReturnType<typeof vi.fn>>,
  session: null as null | { nihoUserId: string; idTokenExpiresAt: number },
  providers: { status: "ok", providers: [] } as { status: string; providers?: Pick<HostProvider, "id" | "memberRole">[] },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ guestReviewRepository: () => state.store, guestQuestionRepository: () => null, siteThreadRepository: () => null }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => state.session, loadHostProviders: async () => state.providers }));
vi.mock("@/lib/host/session", () => ({ idTokenUsable: (session: { idTokenExpiresAt: number }, now: number) => session.idTokenExpiresAt > now }));

import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import {
  draftGuestReviewEnglish,
  GUEST_REVIEW_ALREADY_REPORTED_TEXT,
  GUEST_REVIEW_LOAD_FAILED_TEXT,
  GUEST_REVIEW_MISSING_TEXT,
  GUEST_REVIEW_OWNER_ONLY_TEXT,
  GUEST_REVIEW_REPLY_CHANGED_TEXT,
  GUEST_REVIEW_REPLY_FAILED_TEXT,
  GUEST_REVIEW_REPORT_FAILED_TEXT,
  hostReviewFrom,
  loadGuestReviews,
  loadMoreGuestReviews,
  reportGuestReview,
  saveGuestReviewReply,
} from "./guest-reviews-server";
import { REPLY_DRAFT_TIMEOUT_MS } from "./guest-questions-server";
import { REPLY_DRAFT_FAILED_TEXT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";
import { loadMoreReviewList, publishGuestReviewReply, reportGuestReview as reportGuestReviewAction } from "./review-actions";
import { REVIEW_REPLY_TEXT_LIMIT, REVIEW_REPORT_NOTE_LIMIT, REVIEW_REPORTED_TEXT, reviewReplyStage, reviewSummary, reviewSummaryNotes } from "./reviews";

const REVIEW_ID = "00000000-0000-4000-8000-000000000108";
const OTHER_REVIEW_ID = "00000000-0000-4000-8000-000000000109";
const COMMAND_ID = "00000000-0000-4000-8000-0000000c0108";
const OWNER = { id: "sample-provider", memberRole: "OWNER" } as HostProvider;
const ACTOR: HostActor = { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" };

/** Written just now: no reply, no report, no note. */
const STORED: HostGuestReview = {
  id: REVIEW_ID,
  productId: "tea",
  productTitle: "Synthetic tea",
  bookingPublicId: "NB-SAMPLE-0108",
  // 00:30 on 31 October in Japan.
  sessionStartUtc: "2026-10-30T15:30:00.000Z",
  reviewerName: "Sample Guest",
  reviewerOrigin: "United Kingdom",
  rating: 5,
  tags: ["CALM_ATMOSPHERE", "GREAT_HOST"],
  body: "A calm and lovely afternoon.",
  bodyJa: null,
  language: "EN",
  noteToHost: null,
  submittedAtUtc: "2026-10-31T01:02:03.000Z",
  reply: null,
  report: null,
};
const REPLY = { english: "Thank you for coming.", japanese: "来てくれてありがとう。", repliedAtUtc: "2026-10-31T15:30:00.000Z", editedAtUtc: null, revision: 1 } as const;
const REPLIED: HostGuestReview = { ...STORED, reply: REPLY };

beforeEach(() => {
  state.store = {
    listReviews: vi.fn(async () => ({ reviews: [STORED], nextCursor: null })),
    summarizeReviews: vi.fn(async () => [{ productId: "tea", productTitle: "Synthetic tea", count: 1, ratingTotal: 5 }]),
    getReview: vi.fn(async () => STORED),
    saveReply: vi.fn(async () => REPLIED),
    reportReview: vi.fn(async () => ({ ...STORED, report: { reason: "UNTRUE", note: null, reportedAtUtc: "2026-10-31T02:00:00.000Z" } })),
  };
  state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
  state.providers = { status: "ok", providers: [OWNER, { id: "sample-other", memberRole: "EDITOR" }] };
});

describe("hostReviewFrom", () => {
  it("shows a review as published from when it was written, dated in Japan, open to a reply", () => {
    const review = hostReviewFrom(STORED);
    expect(review).toEqual({
      id: REVIEW_ID,
      experienceId: "tea",
      bookingId: "NB-SAMPLE-0108",
      sessionDate: "2026-10-31",
      reviewer: { name: "Sample Guest", country: "United Kingdom" },
      rating: 5,
      tags: ["CALM_ATMOSPHERE", "GREAT_HOST"],
      body: { original: "A calm and lovely afternoon.", language: "en", translation: null },
      privateNote: null,
      writtenAt: "2026-10-31T10:02",
      status: "published",
      publishedAt: "2026-10-31T10:02",
      reply: null,
      report: null,
    });
    // Nothing waits for NIHO: the screen offers 返信する and counts no 公開前.
    expect(reviewReplyStage(review)).toBe("open");
    expect(reviewSummaryNotes(reviewSummary([review])).join(" ")).not.toContain("公開前");
  });

  it("reads the reply (written in Japanese or English directly, corrected or not), the report, the note, Japanese reviews and no origin", () => {
    expect(hostReviewFrom(REPLIED).reply).toEqual({ japanese: "来てくれてありがとう。", english: "Thank you for coming.", publishedAt: "2026-11-01T00:30", editedAt: null });
    expect(reviewReplyStage(hostReviewFrom(REPLIED))).toBe("replied");
    const corrected = hostReviewFrom({ ...STORED, reply: { ...REPLY, japanese: null, editedAtUtc: "2026-11-01T03:04:00.000Z", revision: 2 } });
    expect(corrected.reply).toEqual({ japanese: "", english: "Thank you for coming.", publishedAt: "2026-11-01T00:30", editedAt: "2026-11-01T12:04" });

    expect(hostReviewFrom({ ...STORED, report: { reason: "PERSONAL", note: "A phone number is in it.", reportedAtUtc: "2026-10-31T02:00:00.000Z" } }).report).toEqual({ at: "2026-10-31T11:00", reason: "personal", note: "A phone number is in it." });
    const reasons = (["PERSONAL", "UNTRUE", "INAPPROPRIATE", "OTHER"] as const).map((reason) => hostReviewFrom({ ...STORED, report: { reason, note: null, reportedAtUtc: "2026-10-31T02:00:00.000Z" } }).report);
    expect(reasons).toEqual(["personal", "untrue", "inappropriate", "other"].map((reason) => ({ at: "2026-10-31T11:00", reason })));

    const japanese = hostReviewFrom({ ...STORED, language: "JA", body: "落ち着いた午後でした。", reviewerOrigin: null, noteToHost: "また行きます。" });
    expect(japanese).toMatchObject({
      reviewer: { name: "Sample Guest", country: "" },
      body: { original: "落ち着いた午後でした。", language: "ja", translation: null },
      privateNote: { original: "また行きます。", language: "ja", translation: null },
    });
    expect(hostReviewFrom({ ...STORED, bodyJa: "落ち着いた素敵な午後でした。", noteToHost: "Thank you!" })).toMatchObject({
      body: { original: "A calm and lovely afternoon.", language: "en", translation: "落ち着いた素敵な午後でした。" },
      privateNote: { original: "Thank you!", language: "en", translation: null },
    });
  });
});

describe("loadGuestReviews", () => {
  it("lists the OWNER's reviews the moment they are written, with each reply's revision, and counts all of them by experience", async () => {
    const older: HostGuestReview = { ...REPLIED, id: OTHER_REVIEW_ID, productId: "walk", productTitle: "Synthetic walk", reply: { ...REPLY, revision: 3 }, submittedAtUtc: "2026-10-20T01:00:00.000Z" };
    state.store!.listReviews!.mockResolvedValueOnce({ reviews: [STORED, older], nextCursor: "c2Vjb25k" });
    // More reviews than the first page holds: the counts and the select come from all of them.
    state.store!.summarizeReviews!.mockResolvedValueOnce([
      { productId: "tea", productTitle: "Synthetic tea", count: 130, ratingTotal: 600 },
      { productId: "walk", productTitle: "Synthetic walk", count: 2, ratingTotal: 9 },
      { productId: "river", productTitle: "Synthetic river", count: 1, ratingTotal: 4 },
    ]);
    const load = await loadGuestReviews(OWNER, "sample-niho-user");
    expect(state.store?.listReviews).toHaveBeenCalledWith(ACTOR, { limit: 100 });
    expect(state.store?.summarizeReviews).toHaveBeenCalledWith(ACTOR);
    expect(load).toMatchObject({
      status: "live",
      revisions: { [REVIEW_ID]: 0, [OTHER_REVIEW_ID]: 3 },
      nextCursor: "c2Vjb25k",
      counts: [
        { experienceId: "tea", title: "Synthetic tea", count: 130, ratingTotal: 600 },
        { experienceId: "walk", title: "Synthetic walk", count: 2, ratingTotal: 9 },
        { experienceId: "river", title: "Synthetic river", count: 1, ratingTotal: 4 },
      ],
      experiences: [{ id: "tea", title: "Synthetic tea" }, { id: "walk", title: "Synthetic walk" }, { id: "river", title: "Synthetic river" }],
      now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    });
    expect(load.status === "live" && load.reviews.map((review) => [review.id, review.status, reviewReplyStage(review)])).toEqual([
      [REVIEW_ID, "published", "open"],
      [OTHER_REVIEW_ID, "published", "replied"],
    ]);
    // Neither the guest's address nor the host's NIHO user id reaches the screen.
    expect(JSON.stringify(load)).not.toMatch(/@|sample-niho-user/);
  });

  it("keeps today's screen while closed, and says the reviews are the OWNER's to anyone else", async () => {
    expect(await loadGuestReviews({ ...OWNER, memberRole: "EDITOR" }, "sample-niho-user")).toEqual({ status: "owner-only" });
    state.store!.listReviews!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadGuestReviews(OWNER, "sample-niho-user")).toEqual({ status: "owner-only" });
    state.store!.summarizeReviews!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadGuestReviews(OWNER, "sample-niho-user")).toEqual({ status: "owner-only" });
    state.store = null;
    expect(await loadGuestReviews(OWNER, "sample-niho-user")).toEqual({ status: "closed" });
    expect(await loadGuestReviews({ ...OWNER, memberRole: "EDITOR" }, "sample-niho-user")).toEqual({ status: "closed" });
  });

  it("says the reviews could not be read when the DB fails", async () => {
    state.store!.listReviews!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadGuestReviews(OWNER, "sample-niho-user")).toEqual({ status: "error" });
  });
});

describe("loadMoreGuestReviews (続きを見る)", () => {
  it("reads the page after the screen's last review, with each reply's revision and where the next page starts", async () => {
    state.store!.listReviews!.mockResolvedValueOnce({ reviews: [REPLIED], nextCursor: null });
    const more = await loadMoreGuestReviews("sample-provider", "c2Vjb25k");
    expect(state.store?.listReviews).toHaveBeenCalledWith(ACTOR, { cursor: "c2Vjb25k", limit: 100 });
    expect(more).toEqual({ ok: true, message: "", reviews: [hostReviewFrom(REPLIED)], revisions: { [REVIEW_ID]: 1 }, nextCursor: null });
  });

  it("says why it could not: the session, the OWNER, a cursor that is not one, or the DB", async () => {
    state.store!.listReviews!.mockRejectedValueOnce(new StoreValidationError("cursor is invalid."));
    expect(await loadMoreGuestReviews("sample-provider", "bad")).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    state.store!.listReviews!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadMoreGuestReviews("sample-provider", "c2Vjb25k")).toEqual({ ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT });
    state.store!.listReviews!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadMoreGuestReviews("sample-provider", "c2Vjb25k")).toEqual({ ok: false, message: GUEST_REVIEW_LOAD_FAILED_TEXT });
    expect(await loadMoreGuestReviews("sample-other", "c2Vjb25k")).toEqual({ ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT });
    state.session = null;
    expect(await loadMoreGuestReviews("sample-provider", "c2Vjb25k")).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    // The action refuses what the screen never sends, before the store is asked.
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
    state.store!.listReviews!.mockClear();
    for (const input of [{ providerId: "not a provider", cursor: "c2Vjb25k" }, { providerId: "sample-provider", cursor: "" }, { providerId: "sample-provider", cursor: "c".repeat(201) }, null]) {
      expect(await loadMoreReviewList(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
    expect(state.store?.listReviews).not.toHaveBeenCalled();
  });
});

describe("draftGuestReviewEnglish (英語にする, #108)", () => {
  const JAPANESE = "来てくださってありがとうございました。またお待ちしています。";
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }], stop_reason: "end_turn" as const });
  /** The real translator over a stubbed Claude API call. */
  function api(answer: () => Promise<ReturnType<typeof reply> | { content: []; stop_reason: "refusal" }>) {
    const create = vi.fn(answer);
    return { create, translator: () => createTranslator(create as never, REPLY_DRAFT_TIMEOUT_MS) as Translator };
  }

  it("drafts the English of the OWNER's Japanese with the review as context, waiting 15 s once, and publishes nothing", async () => {
    const { create, translator } = api(async () => reply("Thank you so much for coming. We hope to see you again."));
    expect(await draftGuestReviewEnglish("sample-provider", REVIEW_ID, JAPANESE, translator)).toEqual({ ok: true, message: "英語にしました", english: "Thank you so much for coming. We hope to see you again." });
    expect(state.store?.getReview).toHaveBeenCalledWith(ACTOR, REVIEW_ID);
    const [body, options] = create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(options).toEqual({ timeout: 15_000, maxRetries: 0 });
    expect(body).toMatchObject({ model: TRANSLATION_MODEL, system: REVIEW_REPLY_TO_ENGLISH_SYSTEM });
    // The review's words, then the host's Japanese; never the reviewer, the experience, the provider or an id.
    expect(body.messages).toEqual([{ role: "user", content: `<review>\nA calm and lovely afternoon.\n</review>\n\n<reply>\n${JAPANESE}\n</reply>` }]);
    expect(JSON.stringify(body)).not.toMatch(/Sample Guest|United Kingdom|sample-provider|sample-niho-user|Synthetic tea|NB-SAMPLE|00000000-/);
    expect(state.store?.saveReply).not.toHaveBeenCalled();
  });

  it("lets the host write the English when translation is off, and try again when the API fails or declines", async () => {
    expect(await draftGuestReviewEnglish("sample-provider", REVIEW_ID, JAPANESE, () => null)).toEqual({ ok: false, message: REPLY_DRAFT_UNAVAILABLE_TEXT });
    const refused = api(async () => ({ content: [], stop_reason: "refusal" }));
    expect(await draftGuestReviewEnglish("sample-provider", REVIEW_ID, JAPANESE, refused.translator)).toEqual({ ok: false, message: REPLY_DRAFT_FAILED_TEXT });
    const down = api(async () => { throw new Error("synthetic outage"); });
    expect(await draftGuestReviewEnglish("sample-provider", REVIEW_ID, JAPANESE, down.translator)).toEqual({ ok: false, message: REPLY_DRAFT_FAILED_TEXT });
  });

  it("asks the Claude API nothing without a usable session, for another provider, or for a review that is not shown", async () => {
    const { create, translator } = api(async () => reply("Thanks!"));
    state.session = null;
    expect(await draftGuestReviewEnglish("sample-provider", REVIEW_ID, JAPANESE, translator)).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
    expect(await draftGuestReviewEnglish("sample-other", REVIEW_ID, JAPANESE, translator)).toEqual({ ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT });
    state.store!.getReview!.mockRejectedValueOnce(new StoreNotFoundError("guest review"));
    expect(await draftGuestReviewEnglish("sample-provider", OTHER_REVIEW_ID, JAPANESE, translator)).toEqual({ ok: false, message: GUEST_REVIEW_MISSING_TEXT });
    state.store!.getReview!.mockRejectedValueOnce(new StoreValidationError("reviewId is invalid."));
    expect(await draftGuestReviewEnglish("sample-provider", "not-a-uuid", JAPANESE, translator)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("saveGuestReviewReply and reportGuestReview", () => {
  it("publish a reply to any shown review and correct it, answering the review as the store has it now", async () => {
    const first = await saveGuestReviewReply("sample-provider", REVIEW_ID, { japanese: "来てくれてありがとう。", english: "Thank you for coming.", commandId: COMMAND_ID, expectedRevision: 0 });
    expect(first).toEqual({ ok: true, message: "返信を公開しました", review: hostReviewFrom(REPLIED), revision: 1 });
    expect(state.store?.saveReply).toHaveBeenCalledWith(ACTOR, REVIEW_ID, { english: "Thank you for coming.", japanese: "来てくれてありがとう。", commandId: COMMAND_ID, expectedRevision: 0 });

    state.store!.saveReply!.mockResolvedValueOnce({ ...STORED, reply: { ...REPLY, japanese: null, english: "Thanks!", editedAtUtc: "2026-11-01T03:04:00.000Z", revision: 2 } });
    const corrected = await saveGuestReviewReply("sample-provider", REVIEW_ID, { japanese: "  ", english: "Thanks!", commandId: COMMAND_ID, expectedRevision: 1 });
    expect(corrected).toMatchObject({ ok: true, message: "返信を直しました", revision: 2, review: { reply: { japanese: "", english: "Thanks!" } } });
    expect(state.store?.saveReply).toHaveBeenLastCalledWith(ACTOR, REVIEW_ID, { english: "Thanks!", japanese: null, commandId: COMMAND_ID, expectedRevision: 1 });
  });

  it("report a review once, the reason in the store's words, and the review stays", async () => {
    const reported = await reportGuestReview("sample-provider", REVIEW_ID, { reason: "untrue", note: "  ", commandId: COMMAND_ID });
    expect(reported).toMatchObject({ ok: true, message: REVIEW_REPORTED_TEXT, revision: 0, review: { id: REVIEW_ID, status: "published", report: { reason: "untrue" } } });
    expect(state.store?.reportReview).toHaveBeenCalledWith(ACTOR, REVIEW_ID, { reason: "UNTRUE", note: null, commandId: COMMAND_ID });
    await reportGuestReview("sample-provider", REVIEW_ID, { reason: "other", note: " Synthetic note ", commandId: COMMAND_ID });
    expect(state.store?.reportReview).toHaveBeenLastCalledWith(ACTOR, REVIEW_ID, { reason: "OTHER", note: "Synthetic note", commandId: COMMAND_ID });
  });

  it("do nothing unless the session is usable and NIHO says this account is the OWNER", async () => {
    const reply = { japanese: "", english: "Thanks!", commandId: COMMAND_ID, expectedRevision: 0 };
    state.session = null;
    expect(await saveGuestReviewReply("sample-provider", REVIEW_ID, reply)).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
    for (const providerId of ["sample-other", "sample-unknown"]) {
      expect(await saveGuestReviewReply(providerId, REVIEW_ID, reply)).toEqual({ ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT });
      expect(await reportGuestReview(providerId, REVIEW_ID, { reason: "other", note: "", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT });
    }
    expect(state.store?.saveReply).not.toHaveBeenCalled();
    expect(state.store?.reportReview).not.toHaveBeenCalled();
    state.providers = { status: "error" };
    expect(await reportGuestReview("sample-provider", REVIEW_ID, { reason: "other", note: "", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_REVIEW_REPORT_FAILED_TEXT });
    state.store = null;
    expect(await saveGuestReviewReply("sample-provider", REVIEW_ID, reply)).toEqual({ ok: false, message: GUEST_REVIEW_REPLY_FAILED_TEXT });
  });

  it("tell the host what the store refused, a hidden review as one not found", async () => {
    const reply = () => saveGuestReviewReply("sample-provider", REVIEW_ID, { japanese: "", english: "Thanks!", commandId: COMMAND_ID, expectedRevision: 0 });
    const report = () => reportGuestReview("sample-provider", REVIEW_ID, { reason: "other", note: "", commandId: COMMAND_ID });
    const cases: [Error, string, string][] = [
      [new StoreAccessDeniedError(), GUEST_REVIEW_OWNER_ONLY_TEXT, GUEST_REVIEW_OWNER_ONLY_TEXT],
      [new StoreNotFoundError("guest review"), GUEST_REVIEW_MISSING_TEXT, GUEST_REVIEW_MISSING_TEXT],
      [new StoreConflictError("synthetic"), GUEST_REVIEW_REPLY_CHANGED_TEXT, GUEST_REVIEW_ALREADY_REPORTED_TEXT],
      [new StoreValidationError("synthetic"), HOST_INVALID_INPUT_TEXT, HOST_INVALID_INPUT_TEXT],
      [new Error("synthetic outage"), GUEST_REVIEW_REPLY_FAILED_TEXT, GUEST_REVIEW_REPORT_FAILED_TEXT],
    ];
    for (const [error, replied, reported] of cases) {
      state.store!.saveReply!.mockRejectedValueOnce(error);
      expect(await reply()).toEqual({ ok: false, message: replied });
      state.store!.reportReview!.mockRejectedValueOnce(error);
      expect(await report()).toEqual({ ok: false, message: reported });
    }
    // The refusal is answered as it is: the review is not read again.
    expect(state.store?.getReview).not.toHaveBeenCalled();
  });
});

describe("review-actions", () => {
  const reply = { providerId: "sample-provider", reviewId: REVIEW_ID, japanese: "来てくれてありがとう。", english: "Thank you for coming.", commandId: COMMAND_ID, expectedRevision: 0 };
  const report = { providerId: "sample-provider", reviewId: REVIEW_ID, reason: "untrue", note: "", commandId: COMMAND_ID };

  it("hand a well-formed reply and report to the store", async () => {
    expect(await publishGuestReviewReply(reply)).toMatchObject({ ok: true, revision: 1 });
    expect(await publishGuestReviewReply({ ...reply, japanese: "", expectedRevision: 1 })).toMatchObject({ ok: true, message: "返信を直しました" });
    expect(await reportGuestReviewAction(report)).toMatchObject({ ok: true, message: REVIEW_REPORTED_TEXT });
    expect(state.store?.saveReply).toHaveBeenCalledTimes(2);
    expect(state.store?.reportReview).toHaveBeenCalledTimes(1);
  });

  it("refuse what the screen never sends, before the store is asked", async () => {
    const invalid = { ok: false, message: HOST_INVALID_INPUT_TEXT };
    const replies = [
      { ...reply, providerId: "not a provider" },
      { ...reply, reviewId: "r".repeat(201) },
      { ...reply, commandId: "not-a-uuid" },
      { ...reply, english: "   " },
      { ...reply, english: "e".repeat(REVIEW_REPLY_TEXT_LIMIT + 1) },
      { ...reply, japanese: "日".repeat(REVIEW_REPLY_TEXT_LIMIT + 1) },
      { ...reply, expectedRevision: -1 },
      { ...reply, expectedRevision: 0.5 },
      { ...reply, expectedRevision: "0" as unknown as number },
      null as unknown as typeof reply,
    ];
    for (const input of replies) expect(await publishGuestReviewReply(input)).toEqual(invalid);
    const reports = [
      { ...report, reason: "PERSONAL" },
      { ...report, reason: "spam" },
      { ...report, commandId: COMMAND_ID.slice(1) },
      { ...report, note: "n".repeat(REVIEW_REPORT_NOTE_LIMIT + 1) },
      { ...report, note: null as unknown as string },
      { ...report, reviewId: 108 as unknown as string },
    ];
    for (const input of reports) expect(await reportGuestReviewAction(input)).toEqual(invalid);
    expect(state.store?.saveReply).not.toHaveBeenCalled();
    expect(state.store?.reportReview).not.toHaveBeenCalled();
  });
});
