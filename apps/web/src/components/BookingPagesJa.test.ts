import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingNotOpen, BookingUnavailable } from "./GuestBookingDetails";
import { FindBookingForm } from "./FindBookingForm";
import { BookingMessages, bookingMessageProblem } from "./BookingMessages";
import { BookingSignOut } from "./BookingSignOut";

/** 日本語で申し込んだ予約の予約ページまわり（#59）。 */
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe("予約ページまわりの日本語（#59）", () => {
  it("リンクが無いとき・読み込めないとき・照会フォームを日本語で出し、英語の既定は変わらない", () => {
    const notOpen = html(createElement(BookingNotOpen, { locale: "ja" }));
    expect(notOpen).toContain('lang="ja"');
    expect(notOpen).toContain("ご予約は、メールのリンクから開いてください");
    expect(notOpen).toContain("新しいリンクを送る");
    expect(notOpen).toContain("お申込みのメールアドレス");
    expect(html(createElement(BookingUnavailable, { locale: "ja" }))).toContain("ご予約を開けませんでした");
    expect(html(createElement(FindBookingForm, { locale: "ja" }))).toContain("リンクをメールで送る");
    expect(html(createElement(BookingNotOpen))).toContain("Open this booking from your email");
    expect(html(createElement(FindBookingForm))).toContain("Email me a link");
  });

  it("ホストとのメッセージ：日本語の枠、ホストの日本語、日本語の送信欄とクイック返信", () => {
    const conversation = { open: true, messages: [
      { id: "1", from: "guest" as const, atUtc: "2026-11-14T00:00:00.000Z", body: "こんにちは" },
      { id: "2", from: "host" as const, atUtc: "2026-11-14T01:00:00.000Z", body: "お待ちしています" },
      { id: "3", from: "support" as const, atUtc: "2026-11-14T02:00:00.000Z", body: "ご連絡ありがとうございます" },
    ] };
    const markup = html(createElement(BookingMessages, {
      publicBookingId: "0f8fad5b-d9cb-469f-a165-70867728950e", hostDisplayName: "合成ホスト", timeZone: "Asia/Tokyo", conversation, locale: "ja",
      quickReplies: [{ label: "遅れそうです", message: "遅れそうです。" }],
    }));
    expect(markup).toContain("あなた");
    expect(markup).toContain("NIHO事務局");
    expect(markup).toContain("お待ちしています");
    expect(markup).toContain("合成ホストへのメッセージ");
    expect(markup).toContain("メッセージを送る");
    expect(markup).toContain("遅れそうです");
    expect(markup).not.toContain("Send message");
    expect(html(createElement(BookingMessages, { publicBookingId: "x", hostDisplayName: "合成ホスト", timeZone: "Asia/Tokyo", conversation: null, locale: "ja" }))).toContain("読み込めませんでした");
  });

  it("送信の失敗は日本語の文言になる", () => {
    expect(bookingMessageProblem({ kind: "closed" }, "合成ホスト", "ja")?.title).toContain("メッセージを送れなくなりました");
    expect(bookingMessageProblem({ kind: "limited", retryAfterSeconds: 90 }, "合成ホスト", "ja")?.title).toContain("2分後");
    expect(bookingMessageProblem({ kind: "failed" }, "合成ホスト", "ja")?.title).toContain("合成ホスト");
    expect(bookingMessageProblem({ kind: "closed" }, "Host")?.title).toBe("This booking no longer takes messages");
    expect(bookingMessageProblem({ kind: "sent" }, "合成ホスト", "ja")).toBeNull();
  });

  it("ログアウトの操作も日本語", () => {
    expect(html(createElement(BookingSignOut, { publicBookingId: "x", locale: "ja" }))).toContain("この端末でログアウトする");
  });
});

describe("日本語の戻りページ（#59）", () => {
  it("予約の種別ごとに日本語で「このあとの流れ」を言い、状況は言わない", async () => {
    const { BookingReturn } = await import("./BookingReturn");
    const page = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(BookingReturn, { showReview: false, locale: "ja", ...props } as never));
    const paid = page({ type: "instant" });
    expect(paid).toContain('lang="ja"');
    expect(paid).toContain("ご予約の確認メールをご確認ください");
    expect(paid).toContain("お支払いが完了すると");
    expect(paid).toContain("このページには、ご予約の状況は表示されません");
    expect(paid).toContain('href="/ja/experiences"');
    expect(page({ type: "instant", freeBooking: true })).toContain("お支払いは不要です");
    expect(page({ type: "approval" })).toContain("ホストが内容を確認します");
    expect(page({ type: "managed-request" })).toContain("NIHO事務局が内容を確認します");
    expect(page({ type: null })).toContain("メールをご確認ください");
    expect(paid).not.toContain("Check your email");
    expect(page({ type: "instant", locale: "en" })).toContain("Check your email for your booking");
  });
});
