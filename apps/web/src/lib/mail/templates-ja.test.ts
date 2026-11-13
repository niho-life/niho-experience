import { describe, expect, it } from "vitest";
import type { BookingConfirmationEmail, BookingLinkEmail, BookingMeetingGuideEmail, BookingNoticeEmail, ReviewInvitationEmail } from "@niho-experience/experience-store";
import { bookingConfirmationEmail, bookingLinkEmail, bookingMeetingGuideEmail, bookingMessageEmail, bookingNoticeEmail, questionReplyEmail, reviewInvitationEmail, supportBookingMessageEmail, type RenderedMail } from "./templates";

/** 日本語で申し込んだゲストへのメール（#59）。合成データのみ。 */
const SITE = "https://experience.example";
const GRANT = "sampleGrantAbcdefghijklmnopqrstuvwxyz012345";
const NOW = new Date("2026-11-01T00:00:00.000Z");

const confirmation: BookingConfirmationEmail = {
  publicBookingId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  guestEmail: "guest@example.com",
  guestName: "合成 花子",
  guestLanguage: "JA",
  experienceTitle: "合成の茶道体験",
  experienceSlug: "sample-tea",
  japaneseOnly: false,
  localDate: "2026-11-14",
  localStartTime: "10:00",
  timeZone: "Asia/Tokyo",
  startUtc: "2026-11-14T01:00:00.000Z",
  adultCount: 2,
  childCount: 1,
  totalAmount: 10_000,
  currency: "JPY",
  cancellationPolicy: "FREE_UNTIL_24H",
  cancellationWindowMinutesBeforeStart: 1_440,
  cancellationRefundBasisPoints: 10_000,
  hostDisplayName: "合成ホスト",
};
const facts = { publicBookingId: confirmation.publicBookingId, guestEmail: "guest@example.com", guestName: "合成 花子", guestLanguage: "JA" as const, experienceTitle: "合成の茶道体験", experienceSlug: "sample-tea", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo", hostDisplayName: "合成ホスト" };

const links = (mail: RenderedMail) => [...mail.text.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
/** 英語のまま残る語（English の固定文）が、日本語のメールに混ざらない。 */
const noEnglishSentence = (mail: RenderedMail) => expect(`${mail.subject}\n${mail.text}`).not.toMatch(/\b(Hi|Your booking|Booking reference|Reply to this email|NIHO support will)\b/);

describe("日本語のゲストへのメール（#59）", () => {
  it("確定メール：日本語で、日付・人数・金額・取消条件・日本語の体験ページと事務局の案内を言う", () => {
    const mail = bookingConfirmationEmail(confirmation, { siteUrl: SITE, now: NOW, bookingPageGrant: GRANT });
    expect(mail.subject).toBe("ご予約が確定しました：合成の茶道体験（2026年11月14日(土) 10:00）");
    expect(mail.text).toContain("合成 花子 様");
    expect(mail.text).toContain("お支払い額: 10,000円");
    expect(mail.text).toContain("人数: 大人2名、子ども1名");
    expect(mail.text).toContain("日本時間");
    expect(mail.text).toContain("まで無料でキャンセルできます");
    expect(mail.text).toContain("NIHO事務局が日本語でご案内します");
    expect(mail.text).not.toContain("英語の表示のみ");
    expect(mail.html).toContain('<html lang="ja">');
    expect(links(mail)).toContain(`${SITE}/ja/experiences/sample-tea`);
    expect(links(mail)).toContain(`${SITE}/bookings/open?lang=ja#g=${GRANT}`);
    noEnglishSentence(mail);
  });

  it("確定メール：無料の予約と、予約ページ（grant）が無いときの出し分け", () => {
    const mail = bookingConfirmationEmail({ ...confirmation, totalAmount: 0 }, { siteUrl: SITE, now: NOW });
    expect(mail.text).toContain("無料のご予約が確定しました。お支払いは不要です。");
    expect(mail.text).toContain("合計: 無料");
    expect(mail.text).not.toContain("/bookings");
    expect(mail.text).not.toContain("英語の表示のみ");
  });

  it("英語のゲストの確定メールは変わらない", () => {
    const mail = bookingConfirmationEmail({ ...confirmation, guestLanguage: "EN", experienceTitle: "Synthetic tea ceremony", hostDisplayName: "Sample Host", guestName: "Sample Guest" }, { siteUrl: SITE, now: NOW, bookingPageGrant: null });
    expect(mail.subject).toBe("Your booking is confirmed: Synthetic tea ceremony, Sat 14 Nov 2026 10:00");
    expect(mail.html).toContain('<html lang="en">');
  });

  it("確認リンクのメール：リンクの grant は fragment だけ", () => {
    const link: BookingLinkEmail = { publicBookingId: confirmation.publicBookingId, guestEmail: "guest@example.com", guestName: "合成 花子", guestLanguage: "JA", experienceTitle: "合成の茶道体験", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo" };
    const mail = bookingLinkEmail(link, { siteUrl: SITE, bookingPageGrant: GRANT });
    expect(mail.subject).toBe("ご予約の確認リンク：合成の茶道体験（2026年11月14日(土) 10:00）");
    expect(mail.subject).not.toContain(GRANT);
    expect(links(mail).filter((href) => href.includes(GRANT))).toEqual([`${SITE}/bookings/open?lang=ja#g=${GRANT}`]);
    expect(mail.text).toContain("お心当たりがない場合は、このメールを破棄してください。");
    noEnglishSentence(mail);
  });

  it("取消・返金・お断りのお知らせ", () => {
    const cancelled: BookingNoticeEmail = { ...facts, kind: "CANCELLED", cancelledBy: "HOST", reason: "WEATHER", refundAmount: 10_000, totalAmount: 10_000, currency: "JPY" };
    const mail = bookingNoticeEmail(cancelled, { siteUrl: SITE });
    expect(mail.subject).toBe("ご予約がキャンセルされました：合成の茶道体験（2026年11月14日(土) 10:00）");
    expect(mail.text).toContain("天候のため、合成ホストがご予約をキャンセルしました。申し訳ありません。");
    expect(mail.text).toContain("10,000円 の返金を手続きしました");
    noEnglishSentence(mail);
    expect(bookingNoticeEmail({ ...cancelled, refundAmount: 0, totalAmount: 0 }, { siteUrl: SITE }).text).toContain("お支払いはありませんでしたので、返金はありません。");

    const refunded = bookingNoticeEmail({ ...facts, kind: "REFUNDED", amount: 10_000, currency: "JPY" }, { siteUrl: SITE, bookingPageGrant: GRANT });
    expect(refunded.subject).toContain("返金が完了しました");
    expect(refunded.text).toContain("5〜10営業日");
    expect(links(refunded)).toContain(`${SITE}/bookings/open?lang=ja#g=${GRANT}`);

    const declined = bookingNoticeEmail({ ...facts, kind: "REQUEST_DECLINED", message: "規定により取消はできません。" }, { siteUrl: SITE });
    expect(declined.text).toContain("規定により取消はできません。");
    expect(declined.text).toContain("ご予約は引き続き有効です");
  });

  it("前日の集合案内：日本語で、写真は添付、予約ページは英語の表示であることと事務局の連絡先を添える", () => {
    const guide: BookingMeetingGuideEmail = {
      publicBookingId: confirmation.publicBookingId, guestEmail: "guest@example.com", guestName: "合成 花子", guestLanguage: "JA",
      experienceTitle: "合成の茶道体験", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
      collectionOverview: "合成駅の東口", address: "合成県合成市1-2-3", accessInstructions: "", entranceInstructions: "", mapUrl: "https://maps.example/x",
      photoAssetId: "00000000-0000-4000-8000-000000000001", itemsToBring: ["タオル", "飲み物"], weatherPlan: "雨でも開催します",
    };
    const mail = bookingMeetingGuideEmail(guide, { siteUrl: SITE, bookingPageGrant: GRANT, photo: new Uint8Array([1, 2, 3]) });
    expect(mail.subject).toBe("集合場所のご案内：合成の茶道体験（2026年11月14日(土) 10:00）");
    expect(mail.text).toContain("集合場所: 合成駅の東口");
    expect(mail.text).toContain("持ち物: タオル、飲み物");
    expect(mail.text).toContain("雨天時の対応：雨でも開催します");
    expect(mail.text).toContain("NIHO事務局が日本語でご案内します");
    expect(mail.attachments?.[0]?.cid).toBe("niho-meeting-place-photo");
    expect(mail.html).toContain('<html lang="ja">');
  });

  it("レビュー依頼：日本語で、投稿ページが英語の表示であることを言う", () => {
    const invitation: ReviewInvitationEmail = { providerId: "provider-a", bookingId: "1", guestEmail: "guest@example.com", guestName: "合成 花子", guestLanguage: "JA", experienceTitle: "合成の茶道体験" };
    const mail = reviewInvitationEmail(invitation, { siteUrl: SITE, token: "tok" });
    expect(mail.subject).toBe("ご参加ありがとうございました：合成の茶道体験");
    expect(links(mail)).toEqual([`${SITE}/reviews/write#t=tok`]);
    expect(mail.text).toContain("現在、英語の表示のみです");
  });

  it("ホスト・事務局のメッセージ：枠は日本語、本文はホストが書いた日本語（無ければ英語）のまま", () => {
    const message = { guestName: "合成 花子", guestLanguage: "JA" as const, hostDisplayName: "合成ホスト", experienceTitle: "合成の茶道体験", english: "See you at the gate.", japanese: "門の前でお会いしましょう。", publicBookingId: confirmation.publicBookingId, localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo" };
    const mail = bookingMessageEmail(message, { siteUrl: SITE, bookingPageGrant: GRANT });
    expect(mail.subject).toBe("合成ホストからご予約についてメッセージが届いています：合成の茶道体験（2026年11月14日(土) 10:00）");
    expect(mail.text).toContain("門の前でお会いしましょう。");
    expect(mail.text).not.toContain("See you at the gate.");
    expect(links(mail)).toContain(`${SITE}/bookings/open?lang=ja#g=${GRANT}`);
    expect(mail.text).toContain("NIHO事務局が日本語でご案内します");
    expect(bookingMessageEmail({ ...message, japanese: null }, { siteUrl: SITE, bookingPageGrant: null }).text).toContain("See you at the gate.");
    expect(bookingMessageEmail(message, { siteUrl: SITE, bookingPageGrant: null }).text).not.toContain("/bookings");
    noEnglishSentence(mail);

    const support = supportBookingMessageEmail(message, { siteUrl: SITE, bookingPageGrant: GRANT });
    expect(support.subject).toContain("NIHO事務局からご予約についてメッセージが届いています");
    expect(support.text).toContain("門の前でお会いしましょう。");
  });

  it("質問への返事のメール：日本語の枠と、メールへの返信は事務局に届くという案内", () => {
    const mail = questionReplyEmail({ siteUrl: SITE, guestName: "合成 花子", guestLanguage: "JA", hostName: "合成ホスト", experienceTitle: "合成の茶道体験", reply: "Yes, we can.", japanese: "はい、できます。", replyToken: "t".repeat(43), linkTtlDays: 14 });
    expect(mail.subject).toBe("合成ホストからご質問への返信が届きました：合成の茶道体験");
    expect(mail.text).toContain("はい、できます。");
    expect(mail.text).toContain("期限は14日です");
    expect(mail.text).toContain("NIHO事務局が日本語でご案内します");
    expect(links(mail)).toEqual([`${SITE}/questions/reply#t=${"t".repeat(43)}`]);
  });

  it("人物ページへのメッセージの返事のメール（#589）：体験の名前が無くても読める", () => {
    const mail = questionReplyEmail({ siteUrl: SITE, guestName: "合成 花子", guestLanguage: "JA", hostName: "合成", experienceTitle: null, reply: "Hello.", japanese: "こんにちは。", replyToken: "t".repeat(43), linkTtlDays: 14 });
    expect(mail.subject).toBe("合成さんからメッセージの返信が届きました");
    expect(mail.text).toContain("あなたのメッセージに、合成さんが返信しました。");
    expect(mail.text).toContain("こんにちは。");
    expect(mail.text).not.toContain("null");
    expect(links(mail)).toEqual([`${SITE}/questions/reply#t=${"t".repeat(43)}`]);
  });
});
