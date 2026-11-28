import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HostAgentPayoutRow } from "@niho-experience/experience-store";
import { HostAgentPayouts } from "./HostAgentPayouts";

const row = (over: Partial<HostAgentPayoutRow> = {}): HostAgentPayoutRow => ({
  publicBookingId: "0f8fad5b-d9cb-469f-a165-708677289501", experienceDate: "2026-12-01", capturedAmount: 10_000, refundedAmount: 2_000, nihoFeeAmount: 1_200, payoutAmount: 6_800,
  dueAtUtc: "2026-12-04T09:00:00.000Z", state: "SCHEDULED", transferredAtUtc: null, sentAmount: null, takenBackAmount: 0, offsetAmount: 0, ...over,
});
const html = (rows: HostAgentPayoutRow[]) => renderToStaticMarkup(createElement(HostAgentPayouts, { rows, settingsHref: "/host/settings?providerId=provider-a#settings-payout" }));

describe("HostAgentPayouts", () => {
  it("shows the amounts and the state, and nothing when there are none", () => {
    expect(html([])).toBe("");
    const out = html([row()]);
    for (const text of ["NIHO からの送金", "体験日 2026-12-01", "予定", "10,000円", "返金等 2,000円", "1,200円", "取り分 6,800円", "予定日 2026-12-04"]) expect(out).toContain(text);
    expect(out).not.toContain("0f8fad5b");
  });

  it("sends a waiting payout to 設定 › 受取口座, dates a sent one, and tells of a taking-back", () => {
    expect(html([row({ state: "AWAITING_ACCOUNT" })])).toContain('href="/host/settings?providerId=provider-a#settings-payout"');
    expect(html([row({ state: "TRANSFERRED", transferredAtUtc: "2026-12-05T01:00:00.000Z" })])).toContain("送金済み（2026-12-05）");
    expect(html([row({ state: "REVIEWING" })])).toContain("確認中");
    expect(html([row({ state: "CANCELLED" })])).toContain("取消");
    const out = html([row({ state: "TRANSFERRED", sentAmount: 6_500, takenBackAmount: 850, offsetAmount: 300 })]);
    expect(out).toContain("850円 を取り戻しています");
    // The amount sent is after the kept amount, shown on its own; before a transfer is begun there is none.
    expect(out).toContain("取り分 6,800円 · 差し引き 300円");
    expect(out).toContain("送金額 6,500円");
    expect(html([row()])).not.toContain("送金額");
  });

  it("says when payouts are paused", () => {
    expect(renderToStaticMarkup(createElement(HostAgentPayouts, { rows: [row()], settingsHref: "/x", paused: true }))).toContain("一時停止中");
    expect(html([row()])).not.toContain("一時停止中");
  });
});
