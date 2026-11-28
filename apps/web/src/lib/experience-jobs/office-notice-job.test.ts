import { describe, expect, it, vi } from "vitest";
import type { ClaimedOfficeNotice } from "@niho-experience/experience-store";
import type { MailMessage, MailResult } from "@/lib/mail/transport";

vi.mock("server-only", () => ({}));

import { runExperienceJobs, type ExperienceJobDeps } from "./drain";

/** 事務局への知らせ (#711): the mail job's step for the first page and first bookings of a host, against stubs. */
const SITE = "https://experience.example";
const OFFICE = "office@example.com";

const notice = (kind: ClaimedOfficeNotice["kind"], extra: Partial<ClaimedOfficeNotice> = {}): ClaimedOfficeNotice => ({
  providerId: "prv_1", kind, attempts: 1, claimToken: "00000000-0000-4000-8000-000000000711", hostName: "合成の会", hostNameEn: "Synthetic Club", route: "SELF", experienceTitle: "茶の体験", createdAt: "2026-11-28T00:00:00.000Z", ...extra,
});

function run(rows: ClaimedOfficeNotice[], results: MailResult[] = []) {
  const sent: MailMessage[] = [];
  const queue = [...rows];
  const claimNotices = vi.fn(async () => queue.splice(0, 1));
  const recordNotice = vi.fn(async (_p: string, _k: string, outcome: "SENT" | "RETRY" | "FAILED", _token: string) => (outcome === "RETRY" ? "PENDING" : outcome) as "PENDING" | "SENT" | "FAILED");
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
    mailer, siteUrl: SITE, now: () => new Date("2026-11-28T00:00:00.000Z"),
    officeNotices: { notices: { claimNotices, recordNotice }, officeRecipient: OFFICE },
  } as unknown as ExperienceJobDeps;
  return { deps, sent, claimNotices, recordNotice };
}

describe("the office notice mail step", () => {
  it("sends the notice to the office in Japanese with public names only, and records it", async () => {
    const t = run([notice("FIRST_PAGE_PUBLISHED"), notice("FIRST_BOOKING_OPENED")]);
    const counts = await runExperienceJobs(t.deps);
    expect(counts.officeNotices).toEqual({ claimed: 2, sent: 2, retried: 0, failed: 0 });
    expect(t.sent.map((mail) => mail.to)).toEqual([OFFICE, OFFICE]);
    const [page, booking] = t.sent;
    expect(page!.subject).toBe("【初めての公開】合成の会");
    expect(booking!.subject).toBe("【初めての予約受付】合成の会");
    expect(page!.text).toContain("自分で登録");
    expect(page!.text).toContain("茶の体験");
    expect(page!.text).toContain(`${SITE}/admin/hosts`);
    expect(t.recordNotice).toHaveBeenNthCalledWith(1, "prv_1", "FIRST_PAGE_PUBLISHED", "SENT", "00000000-0000-4000-8000-000000000711");
  });

  it("ends the step on a transient failure; a refusal for good is final; it is absent when not wired", async () => {
    const transient = run([notice("FIRST_PAGE_PUBLISHED"), notice("FIRST_BOOKING_OPENED")], [{ ok: false, failure: "transient" }]);
    expect((await runExperienceJobs(transient.deps)).officeNotices).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
    expect(transient.recordNotice).toHaveBeenCalledWith("prv_1", "FIRST_PAGE_PUBLISHED", "RETRY", "00000000-0000-4000-8000-000000000711");
    const permanent = run([notice("FIRST_PAGE_PUBLISHED")], [{ ok: false, failure: "permanent" }]);
    expect((await runExperienceJobs(permanent.deps)).officeNotices).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
    const off = run([]);
    expect("officeNotices" in await runExperienceJobs({ ...off.deps, officeNotices: null })).toBe(false);
  });
});
