import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hostAddressConfirmationEmail, hostBookingEmail, hostNotificationEmail } from "./host-templates";
import { hostPushEventFromOutbox } from "@/lib/host/push/outbox";
import { HOST_NOTIFICATION_TOPICS } from "@niho-experience/experience-store";

/** The hosts' emails (#194): Japanese, the push's words, nothing more. Synthetic data only. */
const SITE = "https://experience.example";
const ota = {
  providerId: "provider-a", kind: "CANCELLATION" as const, experienceTitle: "Synthetic <tea>", startsAt: "2026-11-14T01:00:00.000Z", seats: 2,
  ota: { site: "GetYourGuide", change: "CANCELLED" as const }, guestName: "Synthetic\nGuest <b>", productId: "tea",
  url: "/host/bookings?ota=4f1c2b3a-5d6e-4f70-8a91-b2c3d4e5f607&providerId=provider-a", tag: "ota-4f1c2b3a-5d6e-4f70-8a91-b2c3d4e5f607",
};

describe("host emails", () => {
  it("keeps the target provider in the day-before summary's booking link", () => {
    const event = hostPushEventFromOutbox({
      id: "1", providerId: "provider-b", topic: HOST_NOTIFICATION_TOPICS.dayBeforeSummary,
      payload: { v: 1, localDate: "2026-11-09", bookingCount: 2, participantCount: 4 },
      attempts: 1, createdAt: "2026-11-08T09:00:00.000Z",
    }, Date.parse("2026-11-08T09:00:00.000Z"));
    expect(event.ok).toBe(true);
    if (!event.ok) throw new Error("Synthetic summary did not produce an event");
    const mail = hostNotificationEmail(event.event, { siteUrl: SITE });
    expect(mail.text).toContain(`${SITE}/host/bookings?providerId=provider-b`);
    expect(mail.html).toContain(`href="${SITE}/host/bookings?providerId=provider-b"`);
  });
  it("names whom a message is addressed to in the subject and has no experience line (#608)", () => {
    const parsed = hostPushEventFromOutbox({
      id: "1", providerId: "provider-a", topic: HOST_NOTIFICATION_TOPICS.guestQuestion,
      payload: { v: 1, threadId: "00000000-0000-4000-8000-0000000000aa", messageId: "00000000-0000-4000-8000-000000000101", experienceTitle: "人物ページから", personName: "高浜拓也", toMemberId: "hst_0123456789abcdef0123456789abcdef" },
      attempts: 1, createdAt: "2026-11-08T09:00:00.000Z",
    }, Date.parse("2026-11-08T09:00:00.000Z"));
    if (!parsed.ok) throw new Error("Synthetic message did not produce an event");
    const mail = hostNotificationEmail(parsed.event, { siteUrl: SITE });
    expect(mail.subject).toBe("高浜拓也さんあてにメッセージが届きました");
    expect(mail.text).not.toContain("人物ページから");
    expect(mail.text).toContain(`${SITE}/host/messages?thread=00000000-0000-4000-8000-0000000000aa&providerId=provider-a`);
  });
  it("words an OTA cancellation as its push, escaped, with where to handle it", () => {
    const mail = hostBookingEmail(ota, { siteUrl: SITE });
    expect(mail.subject).toBe("GetYourGuide の予約が取り消されました：Synthetic <tea> 11/14（土）10:00");
    expect(mail.text).toContain("GetYourGuide の予約が取り消されました。");
    expect(mail.text).toContain("予約者: Synthetic Guest <b> 様");
    expect(mail.text).toContain("取消・返金・予約者とのやりとりは GetYourGuide で行ってください。");
    expect(mail.html).toContain("Synthetic &lt;tea&gt;");
    expect(mail.html).toContain("Synthetic Guest &lt;b&gt; 様");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain(`href="${SITE}/host/bookings?ota=4f1c2b3a-5d6e-4f70-8a91-b2c3d4e5f607&amp;providerId=provider-a"`);
  });

  it("words a request that needs an assignee: where 対応する is, and that it is not an approval or a payment (#535)", () => {
    const mail = hostBookingEmail({
      providerId: "provider-a", kind: "NEW_BOOKING", assignment: { occurrenceId: "occ-1" }, productId: "tea", experienceTitle: "Synthetic <walk>",
      startsAt: "2026-11-14T01:00:00.000Z", seats: 2, url: "/host/bookings?booking=b1&providerId=provider-a", tag: "assign-x",
    }, { siteUrl: SITE });
    expect(mail.subject).toBe("担当を募集中の申込：Synthetic <walk> 11/14（土）10:00");
    expect(mail.text).toContain("「対応する」を押してください");
    expect(mail.text).toContain("先に押した1人が担当になります");
    expect(mail.text).toContain("承認・支払いの案内・予約の確定は NIHO が行います");
    expect(mail.text).toContain("人数: 2名");
    expect(mail.text).not.toContain("予約者:");
    expect(mail.html).toContain("Synthetic &lt;walk&gt;");
    expect(mail.html).toContain(`href="${SITE}/host/bookings?booking=b1&amp;providerId=provider-a"`);
  });

  it("words this site's cancellation without a site or a guest", () => {
    const mail = hostBookingEmail({ providerId: "provider-a", kind: "CANCELLATION", experienceTitle: "Synthetic walk", startsAt: "2026-11-14T01:00:00.000Z", seats: 1, url: "/host/bookings?booking=b1&providerId=provider-a", tag: "cancellation-b1" }, { siteUrl: SITE });
    expect(mail.subject).toBe("予約が取り消されました：Synthetic walk 11/14（土）10:00");
    expect(mail.text).toContain("このサイトで受けた予約が取り消されました。");
    expect(mail.text).toContain("予約: 体験サイト");
    expect(mail.text).not.toContain("予約者:");
    expect(mail.text).not.toContain("で行ってください");
  });

  it("puts the confirmation token in the fragment only, with its end in Japan time", () => {
    const mail = hostAddressConfirmationEmail({ siteUrl: SITE, token: "tok_EN-123", expiresAt: "2026-11-01T06:05:00.000Z" });
    expect(mail.subject).toBe("通知の宛先の確認");
    expect(mail.text).toContain(`${SITE}/host/notification-email#t=tok_EN-123`);
    expect(mail.text).toContain("11/1 15:05 まで、1 回だけ使えます");
    expect(mail.html).toContain('<html lang="ja">');
  });
});
