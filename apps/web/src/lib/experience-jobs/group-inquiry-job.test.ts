import { describe, expect, it, vi } from "vitest";
import type { GroupInquiryMail } from "@niho-experience/experience-store";
import type { MailMessage, MailResult } from "@/lib/mail/transport";

vi.mock("server-only", () => ({}));

import { runExperienceJobs, type ExperienceJobDeps } from "./drain";

/** 団体・個別の相談 (#532): the mail job's step for the office's notices and the senders' receipts, against stubs. */
const SITE = "https://experience.example";
const NOW = new Date("2026-11-13T00:00:00.000Z");
const OFFICE = "office@example.com";

const inquiry = (recipient: "STAFF" | "SENDER", extra: Partial<GroupInquiryMail> = {}): GroupInquiryMail => ({
  inquiryId: "00000000-0000-4000-8000-000000000532", recipient, attempts: 1, inquiryRef: "IQ-7K3M9Q2X", kind: "SCHOOL", locale: "ja",
  contactName: "山田 花子", contactEmail: "teacher@example.com", message: "修学旅行で体験を探しています。\n30人です。", details: { organization: "サンプル中学校", budgetUnit: "PER_PERSON", budget: "3000円" },
  entry: "EXPERIENCE", experienceSlug: "tea", experienceTitle: "お茶の体験", hostName: "佐藤", createdAt: "2026-11-12T23:00:00.000Z", replyByDate: "2026-11-17", ...extra,
});

function run(rows: GroupInquiryMail[], results: MailResult[] = []) {
  const sent: MailMessage[] = [];
  const queue = [...rows];
  const claimMails = vi.fn(async () => queue.splice(0, 1));
  const recordMail = vi.fn(async (_id: string, _recipient: "STAFF" | "SENDER", outcome: "SENT" | "RETRY" | "FAILED") => (outcome === "RETRY" ? "PENDING" : outcome) as "PENDING" | "SENT" | "FAILED");
  const mailer = { sendMail: vi.fn(async (message: MailMessage) => { sent.push(message); return results.shift() ?? { ok: true as const }; }), close: vi.fn() };
  const empty = <T,>(value: T) => vi.fn(async () => value);
  const deps = {
    questions: { claimReplyDeliveries: empty([]), recordReplyDelivery: vi.fn(), eraseInactiveThreads: empty(0) },
    confirmations: { claimBookingConfirmations: empty({ confirmations: [], abandoned: 0 }), completeBookingConfirmation: vi.fn(), retryBookingConfirmation: vi.fn() },
    bookingLinks: { claimBookingLinks: empty({ links: [], abandoned: 0 }), completeBookingLink: vi.fn(), retryBookingLink: vi.fn() },
    notices: { claimBookingNotices: empty({ notices: [], abandoned: 0 }), completeBookingNotice: vi.fn(), retryBookingNotice: vi.fn() },
    access: null, refunds: null,
    guests: { eraseGuestData: empty(0) }, otaGuests: { eraseGuestDetails: empty(0) },
    translations: { claimTranslations: empty({ translations: [], closed: 0, abandoned: 0 }), recordTranslation: vi.fn(), retryTranslation: vi.fn() }, translator: null,
    hostMail: null, hostAddresses: { purge: empty(0) },
    mailer, siteUrl: SITE, now: () => NOW,
    groupInquiries: { mails: { claimMails, recordMail }, officeRecipient: OFFICE },
  } as unknown as ExperienceJobDeps;
  return { deps, sent, claimMails, recordMail, mailer };
}

describe("the inquiry mail step", () => {
  it("sends the office's notice to the office and the receipt to the sender, in the sender's language, and records each as sent", async () => {
    const t = run([inquiry("STAFF"), inquiry("SENDER")]);
    const counts = await runExperienceJobs(t.deps);
    expect(counts.groupInquiryMails).toEqual({ claimed: 2, sent: 2, retried: 0, failed: 0 });
    expect(t.sent.map((mail) => mail.to)).toEqual([OFFICE, "teacher@example.com"]);
    const [notice, receipt] = t.sent;
    expect(notice!.subject).toBe("【新しい相談】学校：山田 花子（IQ-7K3M9Q2X）");
    expect(notice!.text).toContain("30人です。");
    expect(notice!.text).toContain(`${SITE}/admin/inquiries`);
    expect(receipt!.subject).toBe("ご相談を受け付けました（IQ-7K3M9Q2X）");
    // The receipt says what was received, the reply to expect, that nothing is booked, and the free first talk.
    expect(receipt!.text).toContain("IQ-7K3M9Q2X");
    expect(receipt!.text).toContain("11月17日");
    expect(receipt!.text).toContain("まだ予約は確定していません。");
    expect(receipt!.text).toContain("はじめの相談は無料");
    expect(receipt!.text).toContain("一人あたり");
    expect(t.recordMail).toHaveBeenNthCalledWith(1, "00000000-0000-4000-8000-000000000532", "STAFF", "SENT");
    expect(t.recordMail).toHaveBeenNthCalledWith(2, "00000000-0000-4000-8000-000000000532", "SENDER", "SENT");
  });

  it("writes the receipt in English for an English page", async () => {
    const t = run([inquiry("SENDER", { locale: "en", contactName: "Sample Teacher", message: "A half-day program.", details: {} })]);
    await runExperienceJobs(t.deps);
    expect(t.sent[0]!.subject).toBe("We received your inquiry (IQ-7K3M9Q2X)");
    expect(t.sent[0]!.text).toContain("Nothing is booked yet.");
    expect(t.sent[0]!.text).toContain("by 17 Nov");
    expect(t.sent[0]!.html).toContain('lang="en"');
  });

  it("ends the step on a transient failure and puts the email back; a refusal for good is final", async () => {
    const transient = run([inquiry("STAFF"), inquiry("SENDER")], [{ ok: false, failure: "transient" }]);
    expect((await runExperienceJobs(transient.deps)).groupInquiryMails).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
    expect(transient.recordMail).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000532", "STAFF", "RETRY");
    expect(transient.claimMails).toHaveBeenCalledTimes(1);

    const permanent = run([inquiry("STAFF"), inquiry("SENDER")], [{ ok: false, failure: "permanent" }]);
    expect((await runExperienceJobs(permanent.deps)).groupInquiryMails).toEqual({ claimed: 2, sent: 1, retried: 0, failed: 1 });
    expect(permanent.recordMail).toHaveBeenNthCalledWith(1, "00000000-0000-4000-8000-000000000532", "STAFF", "FAILED");
  });

  it("is absent while the feature is off, and a failing step is reported without a word of any inquiry", async () => {
    const off = run([]);
    const counts = await runExperienceJobs({ ...off.deps, groupInquiries: null });
    expect("groupInquiryMails" in counts).toBe(false);
    const broken = run([]);
    broken.claimMails.mockRejectedValueOnce(new Error("connection reset for teacher@example.com"));
    const onStepError = vi.fn();
    const failed = await runExperienceJobs({ ...broken.deps, onStepError });
    expect(failed.groupInquiryMails).toEqual({ error: "unavailable" });
    expect(JSON.stringify(failed)).not.toContain("teacher@example.com");
    expect(onStepError).toHaveBeenCalledWith("groupInquiryMails", "Error");
  });
});
