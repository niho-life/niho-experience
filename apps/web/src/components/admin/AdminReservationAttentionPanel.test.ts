import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConflictCaseList,
  decodeConflictCases,
  decodePropagationMetrics,
  formatDuration,
  PropagationSummary,
  RESOLUTION_LABEL,
  type ConflictCaseDto,
  type PropagationMetricsDto,
} from "./AdminReservationAttentionPanel";

const stamp = "2099-01-01T00:00:00.000Z";
const openCase = (patch: Partial<ConflictCaseDto> = {}): ConflictCaseDto => ({
  id: "00000000-0000-4000-8000-000000000301", productTitle: "合成の茶道", occurrenceStartAtUtc: "2099-01-03T01:00:00.000Z",
  status: "OPEN", openedAtUtc: stamp, acknowledged: false, assignedToMe: false,
  members: [
    { kind: "EXTERNAL", site: "Airbnb", externalReservationId: "SYN-1", seats: 2, status: "CONFIRMED" },
    { kind: "DIRECT", bookingId: "42", seats: 1, status: "MOVED" },
  ],
  ...patch,
});
const metrics = (patch: Partial<PropagationMetricsDto> = {}): PropagationMetricsDto => ({
  providerId: "synthetic-a", truncated: false,
  counts: { OPEN: 0, COMPLETED: 3, NOT_REQUIRED: 1, ABANDONED: 0, TIMED_OUT: 0 },
  closeVerified: { count: 3, p50Seconds: 125, p95Seconds: 400, maxSeconds: 3_900, over60Minutes: 1 },
  detectionLag: { count: 3, p50Seconds: 40 }, queueWait: { count: 2, p50Seconds: 20 },
  open: { count: 0 },
  ...patch,
});
const list = (cases: readonly ConflictCaseDto[]) => renderToStaticMarkup(createElement(ConflictCaseList, { cases, locked: false, onAcknowledge: () => undefined, onResolve: () => undefined }));

describe("admin reservation attention panel", () => {
  it("decodes only well-formed cases and the selected provider's metrics", () => {
    expect(decodeConflictCases({ cases: [openCase()] })).toHaveLength(1);
    expect(decodeConflictCases({ cases: [{ ...openCase(), members: null }] })).toBeNull();
    expect(decodeConflictCases({})).toBeNull();
    expect(decodePropagationMetrics({ metrics: metrics() }, "synthetic-a")?.providerId).toBe("synthetic-a");
    expect(decodePropagationMetrics({ metrics: metrics() }, "synthetic-b")).toBeNull();
  });

  it("lists open cases with members and actions, and never claims the system cancelled anything", () => {
    const html = list([openCase(), openCase({ id: "resolved", status: "RESOLVED", productTitle: "解決済みの回" })]);
    expect(html).toContain("合成の茶道");
    expect(html).toContain("Airbnb SYN-1 · 2名 · 確定");
    expect(html).toContain("直販 #42 · 1名 · 別の回へ移動");
    expect(html).toContain("担当する");
    expect(html).toContain("対応済みにする");
    expect(html).not.toContain("解決済みの回");
    expect(html).not.toMatch(/取り消しました|返金しました|連絡しました/);
    const mine = list([openCase({ acknowledged: true, assignedToMe: true })]);
    expect(mine).toContain("担当: 自分");
    expect(mine).not.toContain(">担当する<");
    expect(list([])).toContain("要対応はありません");
    expect(Object.keys(RESOLUTION_LABEL)).toEqual(["CUSTOMER_CONTACTED", "ACCEPTED_BOTH", "CANCELLED_AT_SOURCE"]);
  });

  it("summarizes propagation in at most three lines", () => {
    const html = renderToStaticMarkup(createElement(PropagationSummary, { metrics: metrics() }));
    expect(html).toContain("中央値 2分 · 95% 7分 · 最大 1時間5分（3件、60分超 1件）");
    expect(html).toContain("検知の遅れ 中央値 40秒 · 実行待ち 中央値 20秒");
    expect(html.match(/<p/g)).toHaveLength(2);
    const pending = renderToStaticMarkup(createElement(PropagationSummary, { metrics: metrics({
      closeVerified: { count: 0, over60Minutes: 0 }, detectionLag: { count: 0 }, queueWait: { count: 0 },
      counts: { OPEN: 2, COMPLETED: 0, NOT_REQUIRED: 0, ABANDONED: 0, TIMED_OUT: 1 }, open: { count: 2, oldestAgeSeconds: 600 },
    }) }));
    expect(pending).toContain("閉鎖を確認した例はまだありません");
    expect(pending).toContain("確認待ち 2件（最長 10分） · 24時間以内に確認できず 1件");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(59)).toBe("59秒");
    expect(formatDuration(7_200)).toBe("2時間");
  });
});
