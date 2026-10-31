import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BookingAccessGrant,
  BookingConfirmationEmail,
  BookingLinkClaim,
  BookingLinkEmail,
  BookingNoticeClaim,
  BookingNoticeEmail,
  ClaimedBookingConfirmation,
  ClaimedBookingLink,
  ClaimedGuestQuestionReply,
  ClaimedGuestTranslation,
  GuestTranslationClaim,
} from "@niho-experience/experience-store";

vi.mock("server-only", () => ({}));

import type { MailMessage, MailResult } from "@/lib/mail/transport";
import type { Translator } from "@/lib/translation/anthropic";
import { GUEST_TO_JAPANESE_SYSTEM, type TranslationResult } from "@/lib/translation/prompts";
import { EXPERIENCE_JOB_LIMITS, experienceJobActivity, runExperienceJobs, type ExperienceJobDeps } from "./drain";

/** One run of the mail job (#285 slice 5) with a stubbed store and a fake mailer: synthetic data only. */
const SITE = "https://experience.example";
const NOW = new Date("2026-11-01T00:00:00.000Z");
const TOKEN = "sampleTokenAbcdefghijklmnopqrstuvwxyz0123456";

const replyFor = (n: number): ClaimedGuestQuestionReply => ({
  messageId: `00000000-0000-4000-8000-00000000000${n}`, providerId: "provider-a", threadId: "00000000-0000-4000-8000-0000000000aa",
  guestEmail: `guest${n}@example.com`, guestName: `Sample Guest ${n}`, guestLanguage: "EN", experienceTitle: "Synthetic tea ceremony",
  hostDisplayName: "Sample Host", english: "Yes, we can.", replyToken: `${TOKEN.slice(0, -1)}${n}`, replyLinkExpiresAtUtc: "2026-11-15T00:00:00.000Z", attempt: 1,
});

const facts = (n: number): BookingConfirmationEmail => ({
  publicBookingId: `0f8fad5b-d9cb-469f-a165-70867728950${n}`, guestEmail: `booker${n}@example.com`, guestName: `Sample Booker ${n}`,
  experienceTitle: "Synthetic walk", experienceSlug: "sample-walk", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
  startUtc: "2026-11-14T01:00:00.000Z", adultCount: 1, childCount: 0, totalAmount: 3000, currency: "JPY", cancellationPolicy: "NONE",
  hostDisplayName: "Sample Host",
});
const confirmationFor = (n: number, email: BookingConfirmationEmail | null = facts(n), attempts = 1): ClaimedBookingConfirmation => ({ id: String(n), attempts, email });
const translationFor = (n: number, attempts = 1): ClaimedGuestTranslation => ({
  id: String(100 + n), attempts, messageId: `00000000-0000-4000-8000-00000000010${n}`, text: `Sample question ${n}: is there a vegetarian option?`,
});
const claimOf = (translations: ClaimedGuestTranslation[], closed = 0, abandoned = 0): GuestTranslationClaim => ({ translations, closed, abandoned });

function stubs() {
  const questions = {
    claimReplyDeliveries: vi.fn(async (): Promise<ClaimedGuestQuestionReply[]> => []),
    recordReplyDelivery: vi.fn(async (_id: string, outcome: "SENT" | "RETRY" | "FAILED") => (outcome === "RETRY" ? "PENDING" : outcome) as "PENDING" | "SENT" | "FAILED" | "SENDING"),
    eraseInactiveThreads: vi.fn(async () => 0),
  };
  const confirmations = {
    claimBookingConfirmations: vi.fn(async (): Promise<{ confirmations: ClaimedBookingConfirmation[]; abandoned: number }> => ({ confirmations: [], abandoned: 0 })),
    completeBookingConfirmation: vi.fn(async () => {}),
    retryBookingConfirmation: vi.fn(async (): Promise<"RETRY" | "FAILED" | "STALE"> => "RETRY"),
  };
  const bookingLinks = {
    claimBookingLinks: vi.fn(async (): Promise<BookingLinkClaim> => ({ links: [], abandoned: 0 })),
    completeBookingLink: vi.fn(async () => {}),
    retryBookingLink: vi.fn(async (): Promise<"RETRY" | "FAILED" | "STALE"> => "RETRY"),
  };
  const notices = {
    claimBookingNotices: vi.fn(async (): Promise<BookingNoticeClaim> => ({ notices: [], abandoned: 0 })),
    completeBookingNotice: vi.fn(async () => {}),
    retryBookingNotice: vi.fn(async (): Promise<"RETRY" | "FAILED" | "STALE"> => "RETRY"),
  };
  const guests = { eraseGuestData: vi.fn(async () => 0) };
  const translations = {
    claimTranslations: vi.fn(async (): Promise<GuestTranslationClaim> => claimOf([])),
    recordTranslation: vi.fn(async () => true),
    retryTranslation: vi.fn(async (): Promise<"RETRY" | "FAILED" | "STALE"> => "RETRY"),
  };
  const sent: MailMessage[] = [];
  const results: MailResult[] = [];
  const mailer = {
    sendMail: vi.fn(async (message: MailMessage) => {
      sent.push(message);
      return results.shift() ?? { ok: true as const };
    }),
    close: vi.fn(),
  };
  const onStepError = vi.fn();
  const deps: ExperienceJobDeps = { questions, confirmations, notices, bookingLinks, access: null, guests, translations, translator: null, mailer, siteUrl: SITE, now: () => NOW, onStepError };
  return { deps, questions, confirmations, notices, bookingLinks, guests, translations, mailer, sent, results, onStepError };
}

/** A claim that hands out one row per call, as the store does for `limit: 1`. */
function oneAtATime<T>(items: T[]) {
  return async () => items.splice(0, 1);
}
function confirmationsOneAtATime(items: ClaimedBookingConfirmation[], abandoned = 0) {
  let first = true;
  return async () => {
    const claim = { confirmations: items.splice(0, 1), abandoned: first ? abandoned : 0 };
    first = false;
    return claim;
  };
}

let s: ReturnType<typeof stubs>;
beforeEach(() => {
  s = stubs();
});

describe("runExperienceJobs", () => {
  it("does nothing on an empty run, with each step's bounded claim and the erasure a year back", async () => {
    const counts = await runExperienceJobs(s.deps);
    expect(counts).toEqual({
      questionReplies: { claimed: 0, sent: 0, retried: 0, failed: 0 },
      bookingConfirmations: { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 },
      bookingNotices: { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 },
      bookingLinks: { off: true },
      guestTranslations: { off: true },
      guestErasure: { erased: 0 },
      questionErasure: { erased: 0 },
      bookingAccessPurge: { off: true },
    });
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: false });
    // One at a time, each claimed just before it is sent: its lease covers that one send only.
    expect(s.questions.claimReplyDeliveries).toHaveBeenCalledWith({ limit: 1, leaseSeconds: 120, linkTtlDays: 14 });
    expect(s.confirmations.claimBookingConfirmations).toHaveBeenCalledWith({ limit: 1, leaseSeconds: 120 });
    expect(s.guests.eraseGuestData).toHaveBeenCalledWith({ endedBefore: "2025-11-01T00:00:00.000Z", limit: EXPERIENCE_JOB_LIMITS.erasedPerStep });
    expect(s.questions.eraseInactiveThreads).toHaveBeenCalledWith({ lastMessageBefore: "2025-11-01T00:00:00.000Z", limit: EXPERIENCE_JOB_LIMITS.erasedPerStep });
    expect(s.mailer.sendMail).not.toHaveBeenCalled();
    // Translation is off: the store's translation queue is not touched.
    expect(s.translations.claimTranslations).not.toHaveBeenCalled();
  });

  it("emails each host reply with its one-time link and records how it went by the failure's class", async () => {
    s.questions.claimReplyDeliveries.mockImplementation(oneAtATime([replyFor(1), replyFor(2), replyFor(3)]));
    s.results.push({ ok: true }, { ok: false, failure: "permanent" }, { ok: false, failure: "transient" });
    const counts = await runExperienceJobs(s.deps);
    expect(counts.questionReplies).toEqual({ claimed: 3, sent: 1, retried: 1, failed: 1 });
    expect(s.questions.recordReplyDelivery.mock.calls).toEqual([
      [replyFor(1).messageId, "SENT"], [replyFor(2).messageId, "FAILED"], [replyFor(3).messageId, "RETRY"],
    ]);
    expect(s.sent.map((message) => message.to)).toEqual(["guest1@example.com", "guest2@example.com", "guest3@example.com"]);
    expect(s.sent[0]!.subject).toBe("Sample Host replied to your question about Synthetic tea ceremony");
    expect(s.sent[0]!.text).toContain(`${SITE}/questions/reply#t=${replyFor(1).replyToken}`);
    expect(s.sent[0]!.text).toContain("Hi Sample Guest 1,");
  });

  it("stops a step at a transient failure: the rest is not claimed and waits for the next run", async () => {
    s.questions.claimReplyDeliveries.mockImplementation(oneAtATime([replyFor(1), replyFor(2)]));
    s.confirmations.claimBookingConfirmations.mockImplementation(confirmationsOneAtATime([confirmationFor(1), confirmationFor(2)]));
    s.results.push({ ok: false, failure: "transient" }, { ok: false, failure: "transient" });
    const counts = await runExperienceJobs(s.deps);
    expect(counts.questionReplies).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
    expect(counts.bookingConfirmations).toEqual({ claimed: 1, sent: 0, skipped: 0, retried: 1, failed: 0, abandoned: 0 });
    expect(s.questions.claimReplyDeliveries).toHaveBeenCalledTimes(1);
    expect(s.confirmations.claimBookingConfirmations).toHaveBeenCalledTimes(1);
  });

  it("starts no new email once a step has used its time budget", async () => {
    let clock = NOW.getTime();
    s.deps = { ...s.deps, now: () => new Date(clock) };
    s.questions.claimReplyDeliveries.mockImplementation(oneAtATime([replyFor(1), replyFor(2)]));
    s.mailer.sendMail.mockImplementation(async () => {
      clock += EXPERIENCE_JOB_LIMITS.sendBudgetMs;
      return { ok: true as const };
    });
    expect((await runExperienceJobs(s.deps)).questionReplies).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(s.questions.claimReplyDeliveries).toHaveBeenCalledTimes(1);
  });

  it("counts a retry the store turned into FAILED (attempts used up) as failed", async () => {
    s.questions.claimReplyDeliveries.mockResolvedValueOnce([replyFor(1)]);
    s.questions.recordReplyDelivery.mockResolvedValueOnce("FAILED");
    s.results.push({ ok: false, failure: "transient" });
    expect((await runExperienceJobs(s.deps)).questionReplies).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
  });

  it("emails booking confirmations, completes sent, refused and empty ones, and backs off the rest", async () => {
    s.confirmations.claimBookingConfirmations.mockImplementation(confirmationsOneAtATime(
      [confirmationFor(1), confirmationFor(2), confirmationFor(4, null), confirmationFor(5, facts(5), 8)],
      1,
    ));
    s.results.push({ ok: true }, { ok: false, failure: "permanent" }, { ok: false, failure: "transient" });
    s.confirmations.retryBookingConfirmation.mockResolvedValueOnce("FAILED");
    const counts = await runExperienceJobs(s.deps);
    expect(counts.bookingConfirmations).toEqual({ claimed: 4, sent: 1, skipped: 1, retried: 0, failed: 2, abandoned: 1 });
    expect(s.confirmations.completeBookingConfirmation.mock.calls).toEqual([["1"], ["2"], ["4"]]);
    expect(s.confirmations.retryBookingConfirmation.mock.calls).toEqual([["5", 8]]);
    // Nothing goes to a booking whose guest data is gone.
    expect(s.sent.map((message) => message.to)).toEqual(["booker1@example.com", "booker2@example.com", "booker5@example.com"]);
    expect(s.sent[0]!.subject).toBe("Your booking is confirmed: Synthetic walk, Sat 14 Nov 2026 10:00");
    expect(s.sent[0]!.text).toContain(`${SITE}/experiences/sample-walk`);
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: true });
  });

  it("reports the erasure counts", async () => {
    s.guests.eraseGuestData.mockResolvedValueOnce(3);
    s.questions.eraseInactiveThreads.mockResolvedValueOnce(2);
    const counts = await runExperienceJobs(s.deps);
    expect(counts.guestErasure).toEqual({ erased: 3 });
    expect(counts.questionErasure).toEqual({ erased: 2 });
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: true });
  });

  it("runs every step when one fails, and reports that step by the error's class name only", async () => {
    s.questions.claimReplyDeliveries.mockRejectedValueOnce(new Error("connection to guest1@example.com refused"));
    s.confirmations.claimBookingConfirmations.mockResolvedValueOnce({ confirmations: [confirmationFor(1)], abandoned: 0 });
    s.confirmations.completeBookingConfirmation.mockRejectedValueOnce(new TypeError("duplicate key (booker1@example.com)"));
    s.guests.eraseGuestData.mockResolvedValueOnce(1);
    s.questions.eraseInactiveThreads.mockRejectedValueOnce(new RangeError("synthetic"));
    const counts = await runExperienceJobs(s.deps);
    expect(counts).toEqual({
      questionReplies: { error: "unavailable" },
      bookingConfirmations: { error: "unavailable" },
      bookingNotices: { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 },
      bookingLinks: { off: true },
      guestTranslations: { off: true },
      guestErasure: { erased: 1 },
      questionErasure: { error: "unavailable" },
      bookingAccessPurge: { off: true },
    });
    expect(s.onStepError.mock.calls).toEqual([["questionReplies", "Error"], ["bookingConfirmations", "TypeError"], ["questionErasure", "RangeError"]]);
    expect(experienceJobActivity(counts)).toEqual({ failed: true, active: true });
    expect(JSON.stringify(counts)).not.toMatch(/example\.com|Sample|sampleToken/);
  });

  it("answers counts only: no address, name, token or message", async () => {
    s.questions.claimReplyDeliveries.mockResolvedValueOnce([replyFor(1)]);
    s.confirmations.claimBookingConfirmations.mockResolvedValueOnce({ confirmations: [confirmationFor(1)], abandoned: 0 });
    const counts = await runExperienceJobs(s.deps);
    expect(JSON.stringify(counts)).not.toMatch(/example\.com|Sample|sampleToken|tea|walk/i);
  });
});

describe("runExperienceJobs › the guest's booking page (#285 slice 6)", () => {
  const GRANT = "sampleGrantAbcdefghijklmnopqrstuvwxyz012345";
  const linkFacts = (n: number): BookingLinkEmail => ({
    publicBookingId: facts(n).publicBookingId, guestEmail: `booker${n}@example.com`, guestName: `Sample Booker ${n}`,
    experienceTitle: "Synthetic walk", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
  });
  const linkFor = (n: number, email: BookingLinkEmail | null = linkFacts(n), attempts = 1): ClaimedBookingLink => ({ id: String(200 + n), attempts, email });
  function linksOneAtATime(items: ClaimedBookingLink[], abandoned = 0) {
    let first = true;
    return async (): Promise<BookingLinkClaim> => {
      const claim = { links: items.splice(0, 1), abandoned: first ? abandoned : 0 };
      first = false;
      return claim;
    };
  }
  function withAccess(grant: BookingAccessGrant | null = { token: GRANT, expiresAtUtc: "2026-12-01T00:00:00.000Z" }) {
    const access = {
      issueBookingAccessGrant: vi.fn(async (): Promise<BookingAccessGrant | null> => grant),
      purgeExpiredAccess: vi.fn(async () => 0),
    };
    s.deps = { ...s.deps, access };
    return access;
  }

  it("links the confirmation to the booking page with a fresh grant in the URL fragment", async () => {
    const access = withAccess();
    s.confirmations.claimBookingConfirmations.mockResolvedValueOnce({ confirmations: [confirmationFor(1)], abandoned: 0 });
    const counts = await runExperienceJobs(s.deps);
    expect(counts.bookingConfirmations).toMatchObject({ sent: 1 });
    expect(access.issueBookingAccessGrant).toHaveBeenCalledExactlyOnceWith(facts(1).publicBookingId);
    expect(s.sent[0]!.html).toContain(">View your booking</a>");
    expect(s.sent[0]!.text).toContain(`${SITE}/bookings/open#g=${GRANT}`);
    expect(s.sent[0]!.html).toContain(`href="${SITE}/bookings/open#g=${GRANT}"`);
    expect(counts.bookingLinks).toEqual({ claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 });
    expect(counts.bookingAccessPurge).toEqual({ purged: 0 });
    expect(access.purgeExpiredAccess).toHaveBeenCalledWith({ limit: EXPERIENCE_JOB_LIMITS.accessPurgedPerStep });
    expect(JSON.stringify(counts)).not.toContain(GRANT);
  });

  it("sends the confirmation without a link while the page is off or no grant can be issued", async () => {
    s.confirmations.claimBookingConfirmations.mockResolvedValueOnce({ confirmations: [confirmationFor(1)], abandoned: 0 });
    await runExperienceJobs(s.deps);
    expect(s.sent[0]!.text).not.toContain("/bookings/open");
    expect(s.bookingLinks.claimBookingLinks).not.toHaveBeenCalled();
    withAccess(null);
    s.confirmations.claimBookingConfirmations.mockResolvedValueOnce({ confirmations: [confirmationFor(2)], abandoned: 0 });
    await runExperienceJobs(s.deps);
    expect(s.sent[1]!.text).not.toContain("/bookings/open");
    expect(s.sent[1]!.subject).toBe("Your booking is confirmed: Synthetic walk, Sat 14 Nov 2026 10:00");
  });

  it("emails the links Find your booking asked for, skips what can no longer be opened, and backs off the rest", async () => {
    const access = withAccess();
    access.issueBookingAccessGrant.mockResolvedValueOnce({ token: GRANT, expiresAtUtc: "2026-12-01T00:00:00.000Z" }).mockResolvedValueOnce(null);
    s.bookingLinks.claimBookingLinks.mockImplementation(linksOneAtATime([linkFor(1), linkFor(2), linkFor(3, null), linkFor(4), linkFor(5)], 1));
    s.results.push({ ok: true }, { ok: false, failure: "transient" });
    const counts = await runExperienceJobs(s.deps);
    expect(counts.bookingLinks).toEqual({ claimed: 4, sent: 1, skipped: 2, retried: 1, failed: 0, abandoned: 1 });
    expect(s.bookingLinks.completeBookingLink.mock.calls).toEqual([["201"], ["202"], ["203"]]);
    expect(s.bookingLinks.retryBookingLink.mock.calls).toEqual([["204", 1]]);
    // A grant per email; none for a booking the store says can no longer be opened.
    expect(access.issueBookingAccessGrant.mock.calls).toEqual([[linkFacts(1).publicBookingId], [linkFacts(2).publicBookingId], [linkFacts(4).publicBookingId]]);
    expect(s.sent.map((message) => message.to)).toEqual(["booker1@example.com", "booker4@example.com"]);
    expect(s.sent[0]!.subject).toBe("Your booking link: Synthetic walk, Sat 14 Nov 2026 10:00");
    expect(s.sent[0]!.text).toContain(`${SITE}/bookings/open#g=${GRANT}`);
    expect(s.sent[0]!.text).toContain("Hi Sample Booker 1,");
    expect(JSON.stringify(counts)).not.toMatch(/example\.com|Sample|sampleGrant/);
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: true });
  });

  it("reports the purge and a failed link step without stopping the others", async () => {
    const access = withAccess();
    access.purgeExpiredAccess.mockResolvedValueOnce(4);
    s.bookingLinks.claimBookingLinks.mockRejectedValueOnce(new TypeError("synthetic"));
    const counts = await runExperienceJobs(s.deps);
    expect(counts.bookingLinks).toEqual({ error: "unavailable" });
    expect(counts.bookingAccessPurge).toEqual({ purged: 4 });
    expect(s.onStepError.mock.calls).toEqual([["bookingLinks", "TypeError"]]);
    expect(experienceJobActivity(counts)).toEqual({ failed: true, active: true });
  });
});

describe("runExperienceJobs › the guests' Japanese", () => {
  /** A translator stub that answers in turn and records what it was asked. */
  function translator(...answers: TranslationResult[]) {
    return vi.fn<Translator>(async () => answers.shift() ?? { ok: true, text: "合成の翻訳です。" });
  }

  it("translates one claimed message at a time with the guest's text only, and keeps the Japanese", async () => {
    const translate = translator({ ok: true, text: "合成の質問 1：ベジタリアンの選択肢はありますか？" }, { ok: true, text: "合成の質問 2" });
    s.translations.claimTranslations
      .mockResolvedValueOnce(claimOf([translationFor(1)], 2, 1))
      .mockResolvedValueOnce(claimOf([translationFor(2)]))
      .mockResolvedValueOnce(claimOf([]));
    const counts = await runExperienceJobs({ ...s.deps, translator: translate });
    expect(counts.guestTranslations).toEqual({ claimed: 2, translated: 2, retried: 0, failed: 0, closed: 2, abandoned: 1 });
    expect(s.translations.claimTranslations).toHaveBeenCalledWith({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.translationLeaseSeconds });
    expect(s.translations.recordTranslation.mock.calls).toEqual([["101", "合成の質問 1：ベジタリアンの選択肢はありますか？"], ["102", "合成の質問 2"]]);
    expect(translate).toHaveBeenCalledTimes(2);
    const request = translate.mock.calls[0]![0];
    expect(request.system).toBe(GUEST_TO_JAPANESE_SYSTEM);
    expect(request.messages).toEqual([{ role: "user", content: `<message>\n${translationFor(1).text}\n</message>` }]);
    // No id, row or attempt reaches the API.
    expect(JSON.stringify(translate.mock.calls)).not.toMatch(/00000000-|"10[12]"/);
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: true });
    expect(JSON.stringify(counts)).not.toMatch(/Sample|合成/);
  });

  it("puts a message back after a refused or unusable answer and goes on, but stops the run when the API is unreachable", async () => {
    const translate = translator({ ok: false, failure: "refused" }, { ok: false, failure: "unusable" }, { ok: false, failure: "unavailable" });
    s.translations.claimTranslations
      .mockResolvedValueOnce(claimOf([translationFor(1)]))
      .mockResolvedValueOnce(claimOf([translationFor(2, 5)]))
      .mockResolvedValueOnce(claimOf([translationFor(3, 2)]))
      .mockResolvedValueOnce(claimOf([translationFor(4)]));
    s.translations.retryTranslation.mockResolvedValueOnce("RETRY").mockResolvedValueOnce("FAILED").mockResolvedValueOnce("RETRY");
    const counts = await runExperienceJobs({ ...s.deps, translator: translate });
    expect(counts.guestTranslations).toEqual({ claimed: 3, translated: 0, retried: 2, failed: 1, closed: 0, abandoned: 0 });
    expect(s.translations.retryTranslation.mock.calls).toEqual([["101", 1], ["102", 5], ["103", 2]]);
    expect(s.translations.recordTranslation).not.toHaveBeenCalled();
    // The fourth message stays queued for the next run.
    expect(s.translations.claimTranslations).toHaveBeenCalledTimes(3);
  });

  it("stops at the per-run limit and when the run's translation budget is spent", async () => {
    s.translations.claimTranslations.mockImplementation(async () => claimOf([translationFor(1)]));
    const many = await runExperienceJobs({ ...s.deps, translator: translator() });
    expect(many.guestTranslations).toMatchObject({ claimed: EXPERIENCE_JOB_LIMITS.translations, translated: EXPERIENCE_JOB_LIMITS.translations });

    let clock = NOW.getTime();
    const slow = vi.fn<Translator>(async () => {
      clock += 25_000;
      return { ok: true, text: "合成の翻訳です。" };
    });
    s.translations.claimTranslations.mockClear();
    const counts = await runExperienceJobs({ ...s.deps, translator: slow, now: () => new Date(clock) });
    // 0 s, 25 s and 50 s start a call; at 75 s the budget (60 s) is spent.
    expect(counts.guestTranslations).toMatchObject({ claimed: 3, translated: 3 });
    expect(slow).toHaveBeenCalledTimes(3);
  });

  it("reports a store failure as the step's failure, and the next steps still run", async () => {
    s.translations.claimTranslations.mockRejectedValueOnce(new Error("guest1@example.com synthetic"));
    s.guests.eraseGuestData.mockResolvedValueOnce(1);
    const counts = await runExperienceJobs({ ...s.deps, translator: translator() });
    expect(counts.guestTranslations).toEqual({ error: "unavailable" });
    expect(counts.guestErasure).toEqual({ erased: 1 });
    expect(s.onStepError).toHaveBeenCalledWith("guestTranslations", "Error");
  });
});

describe("the notices of cancellations and refunds (#285 slice 7)", () => {
  const noticeFacts = (n: number) => ({
    publicBookingId: `0f8fad5b-d9cb-469f-a165-70867728951${n}`, guestEmail: `notice${n}@example.com`, guestName: `Sample Notice ${n}`,
    experienceTitle: "Synthetic walk", experienceSlug: "sample-walk", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
    hostDisplayName: "Sample Host",
  });
  const noticeFor = (n: number, email: BookingNoticeEmail | null, attempts = 1) => ({ id: String(300 + n), attempts, email });
  function noticesOneAtATime(items: ReturnType<typeof noticeFor>[], abandoned = 0) {
    let first = true;
    return async (): Promise<BookingNoticeClaim> => {
      const claim = { notices: items.splice(0, 1), abandoned: first ? abandoned : 0 };
      first = false;
      return claim;
    };
  }

  it("sends each notice with a fresh booking page link, skips one with nothing to say, and stops at a transient failure", async () => {
    const issue = vi.fn(async (): Promise<BookingAccessGrant | null> => ({ token: TOKEN, expiresAtUtc: "2026-12-01T00:00:00.000Z" }));
    const access = { issueBookingAccessGrant: issue, purgeExpiredAccess: vi.fn(async () => 0) };
    s.notices.claimBookingNotices.mockImplementation(noticesOneAtATime([
      noticeFor(1, { ...noticeFacts(1), kind: "CANCELLED", cancelledBy: "HOST", reason: "WEATHER", refundAmount: 3000, currency: "JPY" }),
      noticeFor(2, null),
      noticeFor(3, { ...noticeFacts(3), kind: "REFUNDED", amount: 3000, currency: "JPY" }),
      noticeFor(4, { ...noticeFacts(4), kind: "REQUEST_DECLINED", message: "Sample reply from support." }),
      noticeFor(5, { ...noticeFacts(5), kind: "REFUNDED", amount: 3000, currency: "JPY" }),
    ], 1));
    s.results.push({ ok: true }, { ok: false, failure: "permanent" }, { ok: false, failure: "transient" });
    const counts = await runExperienceJobs({ ...s.deps, access });
    expect(counts.bookingNotices).toEqual({ claimed: 4, sent: 1, skipped: 1, retried: 1, failed: 1, abandoned: 1 });
    expect(s.notices.claimBookingNotices).toHaveBeenCalledWith({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.noticeLeaseSeconds });
    expect(s.notices.completeBookingNotice.mock.calls).toEqual([["301"], ["302"], ["303"]]);
    expect(s.notices.retryBookingNotice.mock.calls).toEqual([["304", 1]]);
    const cancelled = s.sent.find((message) => message.to === "notice1@example.com")!;
    expect(cancelled.subject).toBe("Your booking is cancelled: Synthetic walk, Sat 14 Nov 2026 10:00");
    expect(cancelled.text).toContain("Sample Host cancelled this booking because of the weather.");
    expect(cancelled.text).toContain("We've started a refund of ¥3,000 to the card you paid with.");
    expect(cancelled.text).toContain(`${SITE}/bookings/open#g=${TOKEN}`);
    expect(s.sent.find((message) => message.to === "notice3@example.com")!.subject).toBe("Your refund is done: Synthetic walk, Sat 14 Nov 2026 10:00");
    expect(s.sent.find((message) => message.to === "notice4@example.com")!.text).toContain("Sample reply from support.");
    expect(JSON.stringify(counts)).not.toMatch(/example\.com|Sample/);
  });
});
