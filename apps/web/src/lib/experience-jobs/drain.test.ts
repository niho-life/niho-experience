import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BookingAccessGrant,
  BookingConfirmationEmail,
  BookingLinkClaim,
  BookingLinkEmail,
  BookingMeetingGuideClaim,
  BookingMeetingGuideEmail,
  BookingNoticeClaim,
  BookingNoticeEmail,
  ClaimedBookingConfirmation,
  ClaimedBookingLink,
  ClaimedBookingMeetingGuide,
  ClaimedBookingMessage,
  ClaimedSupportBookingMessage,
  ClaimedGuestQuestionReply,
  ClaimedQuestionReply,
  ClaimedGuestTranslation,
  GuestTranslationClaim,
  ClaimedHostBookingMail,
  HostAddressConfirmationClaim,
  HostBookingMailClaim,
  RefundStatus,
  RefundSubmission,
  StripeRefundAnswer,
} from "@niho-experience/experience-store";
import { BOOKING_CANCELLATION_LIMITS } from "@niho-experience/experience-store";

vi.mock("server-only", () => ({}));

import type { MailMessage, MailResult } from "@/lib/mail/transport";
import type { Translator } from "@/lib/translation/anthropic";
import { GUEST_TO_JAPANESE_SYSTEM, type TranslationResult } from "@/lib/translation/prompts";
import { EXPERIENCE_JOB_LIMITS, experienceJobActivity, runExperienceJobs, type ExperienceJobDeps } from "./drain";

/** One run of the mail job (#285 slice 5) with a stubbed store and a fake mailer: synthetic data only. */
const SITE = "https://experience.example";
const NOW = new Date("2026-11-01T00:00:00.000Z");
const TOKEN = "sampleTokenAbcdefghijklmnopqrstuvwxyz0123456";
const HOST_TOKEN = "hostConfirmTokenAbcdefghijklmnopqrstuvwxyz01";

const replyFor = (n: number): ClaimedQuestionReply => ({
  kind: "QUESTION",
  messageId: `00000000-0000-4000-8000-00000000000${n}`, providerId: "provider-a", threadId: "00000000-0000-4000-8000-0000000000aa",
  guestEmail: `guest${n}@example.com`, guestName: `Sample Guest ${n}`, guestLanguage: "EN", experienceTitle: "Synthetic tea ceremony",
  hostDisplayName: "Sample Host", english: "Yes, we can.", replyToken: `${TOKEN.slice(0, -1)}${n}`, replyLinkExpiresAtUtc: "2026-11-15T00:00:00.000Z", attempt: 1,
});

/** A host message about a booking made on this site (#285 slice 6b): no reply link of its own. */
const bookingMessageFor = (n: number): ClaimedBookingMessage => ({
  kind: "BOOKING",
  messageId: `00000000-0000-4000-8000-00000000020${n}`, providerId: "provider-a", threadId: "00000000-0000-4000-8000-0000000000bb",
  guestEmail: `booker${n}@example.com`, guestName: `Sample Booker ${n}`, guestLanguage: "EN", experienceTitle: "Synthetic walk",
  hostDisplayName: "Sample Host", english: "See you at the station.", attempt: 1,
  publicBookingId: `0f8fad5b-d9cb-469f-a165-70867728950${n}`, localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
  deliveryRef: `ex1_${(0x200 + n).toString(16).padStart(32, "0")}`,
});

/** An Admin's NIHO support contact in a booking's thread: the same booking mail feedback reference. */
const supportMessageFor = (n: number): ClaimedSupportBookingMessage => ({
  ...bookingMessageFor(n),
  kind: "BOOKING_SUPPORT",
  messageId: `00000000-0000-4000-8000-00000000030${n}`,
  deliveryRef: `ex1_${(0x300 + n).toString(16).padStart(32, "0")}`,
});

const facts = (n: number): BookingConfirmationEmail => ({
  publicBookingId: `0f8fad5b-d9cb-469f-a165-70867728950${n}`, guestEmail: `booker${n}@example.com`, guestName: `Sample Booker ${n}`,
  experienceTitle: "Synthetic walk", experienceSlug: "sample-walk", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
  startUtc: "2026-11-14T01:00:00.000Z", adultCount: 1, childCount: 0, totalAmount: 3000, currency: "JPY", cancellationPolicy: "NONE",
  cancellationWindowMinutesBeforeStart: null, cancellationRefundBasisPoints: 0,
  hostDisplayName: "Sample Host",
});
const deliveryRefFor = (n: number) => `ex1_${n.toString(16).padStart(32, "0")}`;
const confirmationFor = (n: number, email: BookingConfirmationEmail | null = facts(n), attempts = 1): ClaimedBookingConfirmation => ({ id: String(n), deliveryRef: deliveryRefFor(n), attempts, email });
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
  const otaGuests = { eraseGuestDetails: vi.fn(async () => 0) };
  const translations = {
    claimTranslations: vi.fn(async (): Promise<GuestTranslationClaim> => claimOf([])),
    recordTranslation: vi.fn(async () => true),
    retryTranslation: vi.fn(async (): Promise<"RETRY" | "FAILED" | "STALE"> => "RETRY"),
  };
  const cancellations = {
    claimRefundsToSend: vi.fn(async (): Promise<RefundSubmission[]> => []),
    recordRefundSubmission: vi.fn(async (_refundId: string, answer: StripeRefundAnswer): Promise<RefundStatus> => (answer.kind === "rejected" ? "FAILED" : "PENDING")),
  };
  const submit = vi.fn<(refund: RefundSubmission) => Promise<StripeRefundAnswer>>(async () => ({ kind: "accepted", stripeRefundRef: "re_test_1", status: "pending" }));
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
  const hostAddresses = { purge: vi.fn(async () => 0) };
  const hostOutbox = {
    claimBookingMails: vi.fn(async (): Promise<HostBookingMailClaim> => ({ mails: [], abandoned: 0 })),
    completeBookingMail: vi.fn<(id: string) => Promise<void>>(async () => {}),
    retryBookingMail: vi.fn(async (): Promise<"RETRY" | "FAILED" | "STALE"> => "RETRY"),
    claimAddressConfirmations: vi.fn(async (): Promise<HostAddressConfirmationClaim> => ({ confirmations: [], abandoned: 0 })),
    issueAddressConfirmationToken: vi.fn<(id: string) => Promise<string | null>>(async () => HOST_TOKEN),
    completeAddressConfirmation: vi.fn<(id: string) => Promise<void>>(async () => {}),
    retryAddressConfirmation: vi.fn(async (): Promise<"RETRY" | "FAILED" | "STALE"> => "RETRY"),
  };
  const allowed = vi.fn<(providerId: string, kind: string) => Promise<boolean>>(async () => true);
  const deps: ExperienceJobDeps = {
    questions, confirmations, notices, bookingLinks, access: null, refunds: null, guests, otaGuests, translations, translator: null,
    hostMail: null, hostAddresses, mailer, siteUrl: SITE, now: () => NOW, onStepError,
  };
  return { deps, questions, confirmations, notices, bookingLinks, guests, otaGuests, translations, cancellations, submit, mailer, sent, results, onStepError, hostAddresses, hostOutbox, allowed };
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
  it("sends a review invitation only for a currently eligible attendance claim", async () => {
    const rows = [
      { id: "91", deliveryRef: deliveryRefFor(91), attempts: 1, email: null },
      { id: "92", deliveryRef: deliveryRefFor(92), attempts: 1, email: { providerId: "provider-a", bookingId: "42", guestEmail: "guest@example.com", guestName: "Sample Guest", experienceTitle: "Synthetic walk" } },
    ];
    const outbox = {
      claimReviewInvitations: vi.fn(async () => ({ invitations: rows.splice(0, 1), abandoned: 0 })),
      completeReviewInvitation: vi.fn(async () => {}),
      retryReviewInvitation: vi.fn(async () => "RETRY" as const),
    };
    const reviews = { issueInvitation: vi.fn(async () => ({ token: TOKEN, expiresAtUtc: "2026-11-15T00:00:00.000Z" })) };
    const counts = await runExperienceJobs({ ...s.deps, reviewInvitations: { outbox, reviews } });
    expect(counts.reviewInvitations).toEqual({ claimed: 2, sent: 1, skipped: 1, retried: 0, failed: 0, abandoned: 0 });
    expect(reviews.issueInvitation).toHaveBeenCalledOnce();
    expect(outbox.completeReviewInvitation).toHaveBeenCalledTimes(2);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.html).toContain(`/reviews/write#t=${TOKEN}`);
    expect(s.sent[0]?.text).toContain("Thank you for joining Synthetic walk");
  });

  it("does nothing on an empty run, with each step's bounded claim and the erasure a year back", async () => {
    const counts = await runExperienceJobs(s.deps);
    expect(counts).toEqual({
      questionReplies: { claimed: 0, sent: 0, retried: 0, failed: 0 },
      bookingConfirmations: { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 },
      bookingNotices: { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 },
      bookingLinks: { off: true },
      bookingRefunds: { off: true },
      guestTranslations: { off: true },
      guestErasure: { erased: 0 },
      otaGuestErasure: { erased: 0 },
      questionErasure: { erased: 0 },
      bookingAccessPurge: { off: true },
      hostAddressConfirmations: { off: true },
      hostBookingMails: { off: true },
      hostAddressPurge: { purged: 0 },
      providerMediaCleanup: { off: true },
    });
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: false });
    // The addresses of hosts whose access ended go whatever host email's flag (#194).
    expect(s.hostAddresses.purge).toHaveBeenCalledWith({ limit: EXPERIENCE_JOB_LIMITS.hostAddressesPurgedPerStep });
    // One at a time, each claimed just before it is sent: its lease covers that one send only.
    expect(s.questions.claimReplyDeliveries).toHaveBeenCalledWith({ limit: 1, leaseSeconds: 120, linkTtlDays: 14 });
    expect(s.confirmations.claimBookingConfirmations).toHaveBeenCalledWith({ limit: 1, leaseSeconds: 120 });
    expect(s.guests.eraseGuestData).toHaveBeenCalledWith({ endedBefore: "2025-11-01T00:00:00.000Z", limit: EXPERIENCE_JOB_LIMITS.erasedPerStep });
    // The guests of OTA bookings (#194) on the same year.
    expect(s.otaGuests.eraseGuestDetails).toHaveBeenCalledWith({ endedBefore: "2025-11-01T00:00:00.000Z", limit: EXPERIENCE_JOB_LIMITS.erasedPerStep });
    expect(s.questions.eraseInactiveThreads).toHaveBeenCalledWith({ lastMessageBefore: "2025-11-01T00:00:00.000Z", limit: EXPERIENCE_JOB_LIMITS.erasedPerStep });
    expect(s.mailer.sendMail).not.toHaveBeenCalled();
    // Translation is off: the store's translation queue is not touched. Neither are the refunds while resending is off.
    expect(s.translations.claimTranslations).not.toHaveBeenCalled();
    expect(s.cancellations.claimRefundsToSend).not.toHaveBeenCalled();
    expect(s.submit).not.toHaveBeenCalled();
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
    s.otaGuests.eraseGuestDetails.mockResolvedValueOnce(4);
    s.questions.eraseInactiveThreads.mockResolvedValueOnce(2);
    const counts = await runExperienceJobs(s.deps);
    expect(counts.guestErasure).toEqual({ erased: 3 });
    expect(counts.otaGuestErasure).toEqual({ erased: 4 });
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
      bookingRefunds: { off: true },
      guestTranslations: { off: true },
      guestErasure: { erased: 1 },
      otaGuestErasure: { erased: 0 },
      questionErasure: { error: "unavailable" },
      bookingAccessPurge: { off: true },
      hostAddressConfirmations: { off: true },
      hostBookingMails: { off: true },
      hostAddressPurge: { purged: 0 },
      providerMediaCleanup: { off: true },
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

  it("tries every provider media object, aggregates deletion failures, and leaves later steps running", async () => {
    const claims = [
      { assetId: "00000000-0000-4000-8000-000000000001", objectKey: "experience-provider-media/00000000-0000-4000-8000-000000000001.jpg" },
      { assetId: "00000000-0000-4000-8000-000000000002", objectKey: "experience-provider-media/00000000-0000-4000-8000-000000000002.jpg" },
    ];
    const repository = {
      claim: vi.fn(async () => claims),
      complete: vi.fn(async () => true),
    };
    const storage = {
      remove: vi.fn().mockRejectedValueOnce(new Error("synthetic object failure")).mockResolvedValueOnce(undefined),
    };
    s.guests.eraseGuestData.mockResolvedValueOnce(1);
    const counts = await runExperienceJobs({ ...s.deps, providerMediaCleanup: { repository, storage } });
    expect(counts.providerMediaCleanup).toEqual({ error: "unavailable" });
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(repository.complete).toHaveBeenCalledExactlyOnceWith(claims[1]);
    expect(counts.guestErasure).toEqual({ erased: 1 });
    expect(s.onStepError).toHaveBeenCalledWith("providerMediaCleanup", "ProviderMediaCleanupError");
    expect(JSON.stringify(counts)).not.toMatch(/experience-provider-media|00000000/);
  });
});

describe("runExperienceJobs › the guest's booking page (#285 slice 6)", () => {
  const GRANT = "sampleGrantAbcdefghijklmnopqrstuvwxyz012345";
  const linkFacts = (n: number): BookingLinkEmail => ({
    publicBookingId: facts(n).publicBookingId, guestEmail: `booker${n}@example.com`, guestName: `Sample Booker ${n}`,
    experienceTitle: "Synthetic walk", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
  });
  const linkFor = (n: number, email: BookingLinkEmail | null = linkFacts(n), attempts = 1): ClaimedBookingLink => ({ id: String(200 + n), deliveryRef: deliveryRefFor(200 + n), attempts, email });
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

  it("emails a host message about a booking with the host's English and a fresh grant to the booking page, never a reply link (#285 slice 6b)", async () => {
    const access = withAccess();
    s.questions.claimReplyDeliveries.mockImplementation(oneAtATime<ClaimedGuestQuestionReply>([bookingMessageFor(1), replyFor(2)]));
    const counts = await runExperienceJobs(s.deps);
    expect(counts.questionReplies).toEqual({ claimed: 2, sent: 2, retried: 0, failed: 0 });
    expect(access.issueBookingAccessGrant).toHaveBeenCalledWith(bookingMessageFor(1).publicBookingId);
    expect(s.sent[0]!.to).toBe("booker1@example.com");
    expect(s.sent[0]!.subject).toBe("Sample Host sent you a message about your booking: Synthetic walk, Sat 14 Nov 2026 10:00");
    expect(s.sent[0]!.text).toContain("See you at the station.");
    expect(s.sent[0]!.text).toContain(`${SITE}/bookings/open#g=${GRANT}`);
    expect(s.sent[0]!.text).not.toContain("/questions/reply");
    // The reply to a question keeps its own one-time link.
    expect(s.sent[1]!.text).toContain(`${SITE}/questions/reply#t=${replyFor(2).replyToken}`);
    expect(s.questions.recordReplyDelivery.mock.calls).toEqual([[bookingMessageFor(1).messageId, "SENT"], [replyFor(2).messageId, "SENT"]]);
    expect(JSON.stringify(counts)).not.toContain(GRANT);
  });

  it("stamps the bounce-feedback reference on booking thread mail only, never on a reply before booking (#128)", async () => {
    s.questions.claimReplyDeliveries.mockImplementation(oneAtATime<ClaimedGuestQuestionReply>([bookingMessageFor(1), supportMessageFor(2), replyFor(3)]));
    const counts = await runExperienceJobs(s.deps);
    expect(counts.questionReplies).toEqual({ claimed: 3, sent: 3, retried: 0, failed: 0 });
    expect(s.sent.map((message) => message.deliveryRef)).toEqual([bookingMessageFor(1).deliveryRef, supportMessageFor(2).deliveryRef, undefined]);
    expect("deliveryRef" in s.sent[2]!).toBe(false);
    expect(s.sent[1]!.subject).toContain("NIHO support sent you a message about your booking");
    expect(JSON.stringify(counts)).not.toContain("ex1_");
  });

  it("emails a host message about a booking without a link while the page is off or no grant can be issued", async () => {
    s.questions.claimReplyDeliveries.mockResolvedValueOnce([bookingMessageFor(1)]);
    await runExperienceJobs(s.deps);
    expect(s.sent[0]!.text).not.toContain("/bookings/open");
    expect(s.sent[0]!.text).toContain("Replying to this email reaches NIHO support, not Sample Host.");
    withAccess(null);
    s.questions.claimReplyDeliveries.mockResolvedValueOnce([bookingMessageFor(2)]);
    await runExperienceJobs(s.deps);
    expect(s.sent[1]!.text).not.toContain("/bookings/open");
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

describe("runExperienceJobs › private meeting guide email (#376)", () => {
  const email: BookingMeetingGuideEmail = {
    publicBookingId: "0f8fad5b-d9cb-469f-a165-708677289501",
    guestEmail: "guide@example.com", guestName: "Sample Guest", experienceTitle: "Synthetic walk",
    localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
    collectionOverview: "Blue flag by the synthetic station", address: "1-2-3 Sample, Kamakura",
    accessInstructions: "Walk east.", entranceInstructions: "Use the garden gate.",
    mapUrl: "https://maps.example.test/synthetic", photoAssetId: "00000000-0000-4000-8000-000000000401",
    itemsToBring: ["Water bottle"], weatherPlan: "Move indoors in heavy rain.",
  };
  const row: ClaimedBookingMeetingGuide = { id: "701", deliveryRef: deliveryRefFor(701), attempts: 1, email };

  it("sends the captured guide with a private photo and a fresh booking-page grant", async () => {
    const access = { issueBookingAccessGrant: vi.fn(async () => ({ token: TOKEN, expiresAtUtc: "2026-12-01T00:00:00.000Z" })), purgeExpiredAccess: vi.fn(async () => 0) };
    const claimGuides = oneAtATime([row]);
    const guides = {
      claimMeetingGuideDayBefore: vi.fn(async (): Promise<BookingMeetingGuideClaim> => ({ guides: await claimGuides(), abandoned: 0 })),
      completeMeetingGuideDayBefore: vi.fn(async () => {}),
      retryMeetingGuideDayBefore: vi.fn(async () => "RETRY" as const),
    };
    const photos = { read: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff])) };
    const counts = await runExperienceJobs({ ...s.deps, access, meetingGuides: { outbox: guides, photos } });
    expect(counts.meetingGuides).toMatchObject({ claimed: 1, sent: 1, skipped: 0, retried: 0, failed: 0 });
    expect(guides.claimMeetingGuideDayBefore).toHaveBeenCalledWith({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.meetingGuideLeaseSeconds });
    expect(photos.read).toHaveBeenCalledExactlyOnceWith(email.photoAssetId);
    expect(access.issueBookingAccessGrant).toHaveBeenCalledExactlyOnceWith(email.publicBookingId);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.to).toBe(email.guestEmail);
    expect(s.sent[0]!.subject).toContain("Meeting details: Synthetic walk");
    expect(s.sent[0]!.text).toContain(email.address);
    expect(s.sent[0]!.text).toContain("https://maps.example.test/synthetic");
    expect(s.sent[0]!.text).toContain(`${SITE}/bookings/open#g=${TOKEN}`);
    expect(s.sent[0]!.attachments).toEqual([{ filename: "meeting-place.jpg", content: new Uint8Array([0xff, 0xd8, 0xff]), contentType: "image/jpeg", cid: "niho-meeting-place-photo" }]);
    expect(JSON.stringify(s.sent[0])).not.toContain(email.photoAssetId);
    expect(guides.completeMeetingGuideDayBefore).toHaveBeenCalledExactlyOnceWith(row.id);
    expect(JSON.stringify(counts)).not.toContain("guide@example.com");
  });

  it("completes a cancelled or otherwise ineligible row without loading its private photo", async () => {
    const ineligible: ClaimedBookingMeetingGuide = { ...row, email: null };
    const access = { issueBookingAccessGrant: vi.fn(async () => null), purgeExpiredAccess: vi.fn(async () => 0) };
    const claimGuides = oneAtATime([ineligible]);
    const guides = {
      claimMeetingGuideDayBefore: vi.fn(async (): Promise<BookingMeetingGuideClaim> => ({ guides: await claimGuides(), abandoned: 0 })),
      completeMeetingGuideDayBefore: vi.fn(async () => {}),
      retryMeetingGuideDayBefore: vi.fn(async () => "RETRY" as const),
    };
    const photos = { read: vi.fn(async () => new Uint8Array([1])) };
    const counts = await runExperienceJobs({ ...s.deps, access, meetingGuides: { outbox: guides, photos } });
    expect(counts.meetingGuides).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(photos.read).not.toHaveBeenCalled();
    expect(access.issueBookingAccessGrant).not.toHaveBeenCalled();
    expect(s.mailer.sendMail).not.toHaveBeenCalled();
    expect(guides.completeMeetingGuideDayBefore).toHaveBeenCalledExactlyOnceWith(row.id);
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
  const noticeFor = (n: number, email: BookingNoticeEmail | null, attempts = 1) => ({ id: String(300 + n), deliveryRef: deliveryRefFor(300 + n), attempts, email });
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

describe("resending the refunds Stripe has not accepted (#285 slice 7b)", () => {
  const refundFor = (n: number): RefundSubmission => ({
    refundId: `00000000-0000-4000-8000-00000000020${n}`, publicBookingId: `0f8fad5b-d9cb-469f-a165-70867728952${n}`, connectedAccountId: "acct_SampleA0001",
    stripePaymentRef: `pi_sample_${n}`, kind: "FULL", amount: 3000, currency: "JPY", refundApplicationFee: true,
  });
  function refundsOneAtATime(items: RefundSubmission[]) {
    return async (): Promise<RefundSubmission[]> => items.splice(0, 1);
  }
  const withRefunds = (): ExperienceJobDeps => ({ ...s.deps, refunds: { cancellations: s.cancellations, submit: s.submit } });

  it("keeps the job's lease equal to the lease support's resend takes in the store", () => {
    expect(EXPERIENCE_JOB_LIMITS.refundLeaseSeconds).toBe(BOOKING_CANCELLATION_LIMITS.refundSendLeaseSeconds);
    expect(EXPERIENCE_JOB_LIMITS.refundLeaseSeconds).toBeGreaterThanOrEqual(BOOKING_CANCELLATION_LIMITS.refundLeaseSecondsMin);
  });

  it("is off without the Stripe key or while booking on this site is off: nothing is claimed", async () => {
    const counts = await runExperienceJobs(s.deps);
    expect(counts.bookingRefunds).toEqual({ off: true });
    expect(s.cancellations.claimRefundsToSend).not.toHaveBeenCalled();
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: false });
  });

  it("claims one at a time after a grace period, sends each with the stored refund's own fields, and records Stripe's answer", async () => {
    s.cancellations.claimRefundsToSend.mockImplementation(refundsOneAtATime([refundFor(1), refundFor(2), refundFor(3)]));
    s.submit
      .mockResolvedValueOnce({ kind: "accepted", stripeRefundRef: "re_test_1", status: "pending" })
      .mockResolvedValueOnce({ kind: "accepted", stripeRefundRef: "re_test_2", status: "succeeded" })
      .mockResolvedValueOnce({ kind: "rejected", failureCode: "charge_already_refunded" });
    s.cancellations.recordRefundSubmission.mockResolvedValueOnce("PENDING").mockResolvedValueOnce("SUCCEEDED").mockResolvedValueOnce("FAILED");
    const counts = await runExperienceJobs(withRefunds());
    expect(counts.bookingRefunds).toEqual({ claimed: 3, sent: 2, failed: 1, retried: 0 });
    expect(s.cancellations.claimRefundsToSend).toHaveBeenCalledWith({ limit: 1, olderThanSeconds: 120, leaseSeconds: 120 });
    expect(s.submit.mock.calls).toEqual([[refundFor(1)], [refundFor(2)], [refundFor(3)]]);
    expect(s.cancellations.recordRefundSubmission.mock.calls).toEqual([
      [refundFor(1).refundId, { kind: "accepted", stripeRefundRef: "re_test_1", status: "pending" }],
      [refundFor(2).refundId, { kind: "accepted", stripeRefundRef: "re_test_2", status: "succeeded" }],
      [refundFor(3).refundId, { kind: "rejected", failureCode: "charge_already_refunded" }],
    ]);
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: true });
    // Counts only: no refund, booking, payment or account.
    expect(JSON.stringify(counts)).not.toMatch(/0000|0f8fad5b|pi_sample|acct_|re_test/);
  });

  it("stops the step when Stripe cannot be reached: the rest is not claimed, and the refund is tried again later", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      s.cancellations.claimRefundsToSend.mockImplementation(refundsOneAtATime([refundFor(1), refundFor(2)]));
      s.submit.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED pi_sample_1 acct_SampleA0001"), { name: "StripeConnectionError" }));
      const counts = await runExperienceJobs(withRefunds());
      expect(counts.bookingRefunds).toEqual({ claimed: 1, sent: 0, failed: 0, retried: 1 });
      expect(s.cancellations.claimRefundsToSend).toHaveBeenCalledTimes(1);
      expect(s.cancellations.recordRefundSubmission).not.toHaveBeenCalled();
      // The log names the step and the error's class, never Stripe's message.
      expect(log.mock.calls).toEqual([["Experience refund could not be sent", { stage: "stripe", error: "StripeConnectionError" }]]);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/pi_sample|acct_|ECONNREFUSED/);
    } finally {
      log.mockRestore();
    }
  });

  it("counts an answer Stripe gave but the store could not record as retried, and stops", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      s.cancellations.claimRefundsToSend.mockImplementation(refundsOneAtATime([refundFor(1), refundFor(2)]));
      s.cancellations.recordRefundSubmission.mockRejectedValueOnce(new Error("synthetic"));
      const counts = await runExperienceJobs(withRefunds());
      expect(counts.bookingRefunds).toEqual({ claimed: 1, sent: 0, failed: 0, retried: 1 });
      expect(s.submit).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("stops at the per-run limit and when the step's time budget is spent", async () => {
    s.cancellations.claimRefundsToSend.mockImplementation(async () => [refundFor(1)]);
    const many = await runExperienceJobs(withRefunds());
    expect(many.bookingRefunds).toEqual({ claimed: EXPERIENCE_JOB_LIMITS.refunds, sent: EXPERIENCE_JOB_LIMITS.refunds, failed: 0, retried: 0 });

    let clock = NOW.getTime();
    s.submit.mockImplementation(async () => {
      clock += EXPERIENCE_JOB_LIMITS.sendBudgetMs;
      return { kind: "accepted", stripeRefundRef: "re_test_1", status: "pending" };
    });
    s.cancellations.claimRefundsToSend.mockClear();
    const slow = await runExperienceJobs({ ...withRefunds(), now: () => new Date(clock) });
    expect(slow.bookingRefunds).toEqual({ claimed: 1, sent: 1, failed: 0, retried: 0 });
    expect(s.cancellations.claimRefundsToSend).toHaveBeenCalledTimes(1);
  });

  it("reports a store failure as the step's failure by its class only, and the next steps still run", async () => {
    s.cancellations.claimRefundsToSend.mockRejectedValueOnce(new TypeError("pi_sample_1 synthetic"));
    s.guests.eraseGuestData.mockResolvedValueOnce(1);
    const counts = await runExperienceJobs(withRefunds());
    expect(counts.bookingRefunds).toEqual({ error: "unavailable" });
    expect(counts.guestErasure).toEqual({ erased: 1 });
    expect(s.onStepError).toHaveBeenCalledWith("bookingRefunds", "TypeError");
    expect(s.submit).not.toHaveBeenCalled();
  });

  it("runs after the mail steps and before translation", async () => {
    const order: string[] = [];
    s.confirmations.claimBookingConfirmations.mockImplementation(async () => { order.push("mail"); return { confirmations: [], abandoned: 0 }; });
    s.cancellations.claimRefundsToSend.mockImplementation(async () => { order.push("refunds"); return []; });
    s.translations.claimTranslations.mockImplementation(async () => { order.push("translation"); return claimOf([]); });
    await runExperienceJobs({ ...withRefunds(), translator: vi.fn<Translator>() });
    expect(order).toEqual(["mail", "refunds", "translation"]);
  });
});

/** ホストへのメール (#194): a booking's email row as the store hands it out (the push's payload, the address in use now). */
const REF = "4f1c2b3a-5d6e-4f70-8a91-b2c3d4e5f607";
const hostMailOf = (n: number, overrides: Partial<ClaimedHostBookingMail> = {}): ClaimedHostBookingMail => ({
  id: String(500 + n), attempts: 1, providerId: "provider-a", notificationTopic: "host.notify.new_booking",
  payload: { v: 1, bookingId: `0f8fad5b-d9cb-469f-a165-70867728950${n}`, experienceTitle: "Synthetic walk", startsAt: "2026-11-14T01:00:00.000Z", seats: 2 },
  createdAt: "2026-10-31T23:50:00.000Z", to: `owner${n}@example.test`, guestName: null, ...overrides,
});
const otaMail = (n: number, overrides: Partial<ClaimedHostBookingMail> = {}) => hostMailOf(n, {
  notificationTopic: "host.notify.ota_booking",
  payload: { v: 1, change: "RESCHEDULED", site: "Jalan", ref: REF, productId: "tea", experienceTitle: "Synthetic tea", startsAt: "2026-11-16T01:00:00.000Z", previousStartsAt: "2026-11-15T01:00:00.000Z", seats: 3 },
  guestName: "Synthetic Guest", ...overrides,
});
function hostMailsOneAtATime(items: ClaimedHostBookingMail[]) {
  return async (): Promise<HostBookingMailClaim> => ({ mails: items.splice(0, 1), abandoned: 0 });
}

describe("host emails (#194)", () => {
  const withHostMail = () => ({ ...s.deps, hostMail: { outbox: s.hostOutbox, allowed: s.allowed } });

  it("emails each booking's people what its push says, at the address in use, and skips what should not go", async () => {
    s.hostOutbox.claimBookingMails.mockImplementation(hostMailsOneAtATime([
      hostMailOf(1),
      otaMail(2),
      // No address, or no longer the booking's person.
      hostMailOf(3, { to: null }),
      // A day old: no longer news.
      hostMailOf(4, { createdAt: "2026-10-30T00:00:00.000Z" }),
      // Turned off in 設定 › 通知.
      hostMailOf(5, { notificationTopic: "host.notify.cancellation" }),
    ]));
    s.allowed.mockImplementation(async (_providerId: string, kind: string) => kind !== "CANCELLATION");
    const counts = await runExperienceJobs(withHostMail());
    expect(counts.hostBookingMails).toEqual({ claimed: 5, sent: 2, skipped: 3, retried: 0, failed: 0, abandoned: 0 });
    expect(s.hostOutbox.claimBookingMails).toHaveBeenCalledWith({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.hostMailLeaseSeconds });
    expect(s.hostOutbox.completeBookingMail.mock.calls.map(([id]) => id)).toEqual(["501", "502", "503", "504", "505"]);
    expect(s.sent.map((mail) => mail.to)).toEqual(["owner1@example.test", "owner2@example.test"]);

    const [site, ota] = s.sent;
    expect(site!.subject).toBe("新しい予約・申込：Synthetic walk 11/14（土）10:00");
    expect(site!.text).toContain("このサイトで新しい予約を受けました。");
    expect(site!.text).toContain("人数: 2名");
    expect(site!.text).toContain(`${SITE}/host/bookings?booking=0f8fad5b-d9cb-469f-a165-708677289501&providerId=provider-a`);
    expect(site!.html).toContain('<html lang="ja">');

    expect(ota!.subject).toBe("じゃらん の予約の日時が変わりました：Synthetic tea 11/16（月）10:00");
    expect(ota!.text).toContain("予約サイト: じゃらん");
    expect(ota!.text).toContain("日時（変更前 → 変更後）: 11/15（日）10:00 → 11/16（月）10:00");
    expect(ota!.text).toContain("予約者: Synthetic Guest 様");
    expect(ota!.text).toContain("人数: 3名");
    expect(ota!.text).toContain(`${SITE}/host/bookings?ota=${REF}&providerId=provider-a`);
    expect(ota!.text).toContain("取消・返金・予約者とのやりとりは じゃらん で行ってください。");
    expect(ota!.text).toContain(`${SITE}/host/settings#settings-notification`);
    // Only the push's facts: no product ID or reservation handle in the words, only in the link.
    expect(ota!.text.replace(/https:\S+/g, "")).not.toMatch(/productId|4f1c2b3a/);
  });

  it("tries a transient failure again later and stops the step; a permanent one is closed", async () => {
    s.hostOutbox.claimBookingMails.mockImplementation(hostMailsOneAtATime([hostMailOf(1), hostMailOf(2), hostMailOf(3)]));
    s.results.push({ ok: false, failure: "permanent" }, { ok: false, failure: "transient" });
    const counts = await runExperienceJobs(withHostMail());
    expect(counts.hostBookingMails).toEqual({ claimed: 2, sent: 0, skipped: 0, retried: 1, failed: 1, abandoned: 0 });
    expect(s.hostOutbox.retryBookingMail).toHaveBeenCalledWith("502", 1);
    expect(s.hostOutbox.completeBookingMail.mock.calls as unknown[]).toEqual([["501"]]);
  });

  it("sends the confirmation link with a token made right before it goes, and nothing for a request no longer open", async () => {
    const rows = [
      { id: "601", attempts: 1, confirmation: { confirmationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", email: "desk@example.test", expiresAt: "2026-11-01T01:00:00.000Z" } },
      { id: "602", attempts: 1, confirmation: null },
      { id: "603", attempts: 1, confirmation: { confirmationId: "16fd2706-8baf-433b-82eb-8c7fada847da", email: "late@example.test", expiresAt: "2026-11-01T00:30:00.000Z" } },
    ];
    s.hostOutbox.claimAddressConfirmations.mockImplementation(async () => ({ confirmations: rows.splice(0, 1), abandoned: 0 }));
    s.hostOutbox.issueAddressConfirmationToken.mockResolvedValueOnce(HOST_TOKEN).mockResolvedValueOnce(null);
    const counts = await runExperienceJobs(withHostMail());
    expect(counts.hostAddressConfirmations).toEqual({ claimed: 3, sent: 1, skipped: 2, retried: 0, failed: 0, abandoned: 0 });
    expect(s.hostOutbox.issueAddressConfirmationToken.mock.calls as unknown[]).toEqual([["7c9e6679-7425-40de-944b-e07fc1f90ae7"], ["16fd2706-8baf-433b-82eb-8c7fada847da"]]);
    expect(s.sent).toHaveLength(1);
    const [mail] = s.sent;
    expect(mail!.to).toBe("desk@example.test");
    expect(mail!.subject).toBe("通知の宛先の確認");
    expect(mail!.text).toContain(`${SITE}/host/notification-email#t=${HOST_TOKEN}`);
    expect(mail!.text).toContain("11/1 10:00 まで、1 回だけ使えます");
    expect(mail!.text).toContain("心当たりがなければ、このメールは無視してください。");
    // The token is in the fragment only.
    expect(mail!.text).not.toContain(`?t=${HOST_TOKEN}`);
  });
});
