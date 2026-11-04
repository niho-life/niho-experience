import { describe, expect, it } from "vitest";
import type { ExperienceHostApiFailure } from "@niho-experience/api-client/legacy-host";
import { HOST_ERROR_REASON_TEXT, hostFailureMessage } from "./errors";

const refusal = (status: number, reason: string | null, code = "CONFLICT"): ExperienceHostApiFailure => ({ ok: false, kind: "error", status, code, reason, message: "NIHO's own words, not for hosts" });

describe("NIHO's refusals in the host's words", () => {
  it("keeps specific host guidance for the provider and payout reasons it explains", () => {
    // These provider and payout reasons have custom guidance; other contract reasons use the status fallback.
    expect(Object.keys(HOST_ERROR_REASON_TEXT).sort()).toEqual(
      [
        "PROVIDER_CONSENT_OUTDATED",
        "PROVIDER_EMAIL_REQUIRED",
        "PROVIDER_REVIEW_STATE_CONFLICT",
        "PROVIDER_PAYMENT_SOURCE_FORBIDDEN",
        "PROVIDER_PAYMENT_LOCKED",
        "PROVIDER_PAYMENT_CONSENT_OUTDATED",
        "PROVIDER_PAYMENT_SOURCE_NOT_READY",
        "PROVIDER_CONNECT_UNAVAILABLE",
        "PROVIDER_PAYMENT_SHARED_ACCOUNT",
        "PROVIDER_PAYMENT_NOT_CONNECTED",
      ].sort(),
    );
    for (const [reason, text] of Object.entries(HOST_ERROR_REASON_TEXT)) {
      expect(text, reason).toMatch(/。$/);
      expect(text, reason).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });

  it("names the reason when NIHO gives one", () => {
    expect(hostFailureMessage(refusal(409, "PROVIDER_PAYMENT_LOCKED"))).toBe("申込があるため口座は変更できません。");
    expect(hostFailureMessage(refusal(422, "PROVIDER_CONSENT_OUTDATED", "UNPROCESSABLE_ENTITY"))).toContain("提供者規約が新しくなりました");
    expect(hostFailureMessage(refusal(404, "PROVIDER_PAYMENT_SOURCE_FORBIDDEN", "NOT_FOUND"))).toContain("選んだ拠点の口座は使えません");
    expect(hostFailureMessage(refusal(409, "PROVIDER_PAYMENT_NOT_CONNECTED"))).toBe("口座がまだ接続されていません。「Stripe で口座を接続」から進めてください。");
  });

  it("falls back on the status for reasons it does not know, and never shows NIHO's message", () => {
    const cases: [ExperienceHostApiFailure, string][] = [
      [refusal(400, null, "VALIDATION_ERROR"), "入力を確かめてください。"],
      [refusal(401, null, "UNAUTHORIZED"), "ログインの有効期限が切れました。ページを読み込み直してください。"],
      [refusal(403, null, "FORBIDDEN"), "この操作をする権限がありません。提供者のオーナーに依頼してください。"],
      [refusal(404, "PROVIDER_NOT_FOUND", "NOT_FOUND"), "提供者が見つかりません。権限が無いか、URL が正しくありません。"],
      [refusal(409, "SOMETHING_NEW"), "いまはこの操作ができません。ページを読み込み直してから、もう一度お試しください。"],
      [refusal(429, null, "RATE_LIMITED"), "操作が続いています。少し待ってから、もう一度お試しください。"],
      [refusal(503, null, "UNAVAILABLE"), "NIHO で問題が起きました。時間をおいて、もう一度お試しください。"],
      [{ ok: false, kind: "network_error" }, "NIHO に接続できませんでした。時間をおいて、もう一度お試しください。"],
      [{ ok: false, kind: "unexpected_response", status: 200 }, "NIHO から読めない応答がありました。時間をおいて、もう一度お試しください。"],
    ];
    for (const [failure, text] of cases) expect(hostFailureMessage(failure), JSON.stringify(failure)).toBe(text);
    // An inherited name is not a reason.
    expect(hostFailureMessage(refusal(409, "constructor"))).toBe("いまはこの操作ができません。ページを読み込み直してから、もう一度お試しください。");
  });
});
