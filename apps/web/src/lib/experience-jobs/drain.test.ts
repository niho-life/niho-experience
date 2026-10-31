import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingConfirmationEmail, ClaimedBookingConfirmation, ClaimedGuestQuestionReply } from "@niho-experience/experience-store";

vi.mock("server-only", () => ({}));

import type { MailMessage, MailResult } from "@/lib/mail/transport";
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
  const guests = { eraseGuestData: vi.fn(async () => 0) };
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
  const deps: ExperienceJobDeps = { questions, confirmations, guests, mailer, siteUrl: SITE, now: () => NOW, onStepError };
  return { deps, questions, confirmations, guests, mailer, sent, results, onStepError };
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
      guestErasure: { erased: 0 },
      questionErasure: { erased: 0 },
    });
    expect(experienceJobActivity(counts)).toEqual({ failed: false, active: false });
    expect(s.questions.claimReplyDeliveries).toHaveBeenCalledWith({ limit: 20, leaseSeconds: 120, linkTtlDays: 14 });
    expect(s.confirmations.claimBookingConfirmations).toHaveBeenCalledWith({ limit: 20, leaseSeconds: 120 });
    expect(s.guests.eraseGuestData).toHaveBeenCalledWith({ endedBefore: "2025-11-01T00:00:00.000Z", limit: EXPERIENCE_JOB_LIMITS.erasedPerStep });
    expect(s.questions.eraseInactiveThreads).toHaveBeenCalledWith({ lastMessageBefore: "2025-11-01T00:00:00.000Z", limit: EXPERIENCE_JOB_LIMITS.erasedPerStep });
    expect(s.mailer.sendMail).not.toHaveBeenCalled();
  });

  it("emails each host reply with its one-time link and records how it went by the failure's class", async () => {
    s.questions.claimReplyDeliveries.mockResolvedValueOnce([replyFor(1), replyFor(2), replyFor(3)]);
    s.results.push({ ok: true }, { ok: false, failure: "transient" }, { ok: false, failure: "permanent" });
    const counts = await runExperienceJobs(s.deps);
    expect(counts.questionReplies).toEqual({ claimed: 3, sent: 1, retried: 1, failed: 1 });
    expect(s.questions.recordReplyDelivery.mock.calls).toEqual([
      [replyFor(1).messageId, "SENT"], [replyFor(2).messageId, "RETRY"], [replyFor(3).messageId, "FAILED"],
    ]);
    expect(s.sent.map((message) => message.to)).toEqual(["guest1@example.com", "guest2@example.com", "guest3@example.com"]);
    expect(s.sent[0]!.subject).toBe("Sample Host replied to your question about Synthetic tea ceremony");
    expect(s.sent[0]!.text).toContain(`${SITE}/questions/reply#t=${replyFor(1).replyToken}`);
    expect(s.sent[0]!.text).toContain("Hi Sample Guest 1,");
  });

  it("counts a retry the store turned into FAILED (attempts used up) as failed", async () => {
    s.questions.claimReplyDeliveries.mockResolvedValueOnce([replyFor(1)]);
    s.questions.recordReplyDelivery.mockResolvedValueOnce("FAILED");
    s.results.push({ ok: false, failure: "transient" });
    expect((await runExperienceJobs(s.deps)).questionReplies).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
  });

  it("emails booking confirmations, completes sent, refused and empty ones, and backs off the rest", async () => {
    s.confirmations.claimBookingConfirmations.mockResolvedValueOnce({
      confirmations: [confirmationFor(1), confirmationFor(2), confirmationFor(3), confirmationFor(4, null), confirmationFor(5, facts(5), 8)],
      abandoned: 1,
    });
    s.results.push({ ok: true }, { ok: false, failure: "permanent" }, { ok: false, failure: "transient" }, { ok: false, failure: "transient" });
    s.confirmations.retryBookingConfirmation.mockResolvedValueOnce("RETRY").mockResolvedValueOnce("FAILED");
    const counts = await runExperienceJobs(s.deps);
    expect(counts.bookingConfirmations).toEqual({ claimed: 5, sent: 1, skipped: 1, retried: 1, failed: 2, abandoned: 1 });
    expect(s.confirmations.completeBookingConfirmation.mock.calls).toEqual([["1"], ["2"], ["4"]]);
    expect(s.confirmations.retryBookingConfirmation.mock.calls).toEqual([["3", 1], ["5", 8]]);
    // Nothing goes to a booking whose guest data is gone.
    expect(s.sent.map((message) => message.to)).toEqual(["booker1@example.com", "booker2@example.com", "booker3@example.com", "booker5@example.com"]);
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
      guestErasure: { erased: 1 },
      questionErasure: { error: "unavailable" },
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
