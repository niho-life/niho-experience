import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChannelRuntimeOverview } from "@niho-experience/experience-store";
import { decodeRuntimeOverview, isReauthReason, RuntimeOverviewBody, studioStopped } from "./AdminChannelRuntimePanel";

const stamp = "2099-01-01T00:00:00.000Z";
const overview = (patch: Partial<ChannelRuntimeOverview> = {}): ChannelRuntimeOverview => ({
  providerId: "synthetic-a", generatedAtUtc: stamp, watchdogLastRunAtUtc: stamp, watchdogStale: false, openHold: false, unclosedOccurrences: 0,
  workers: [{ id: "worker-a", displayName: "合成Studio", lastHeartbeatAtUtc: stamp, health: "FRESH", openHold: false, assignedAccounts: 1 }],
  accounts: [{
    id: "account-a", site: "GetYourGuide", displayName: "合成アカウント", active: true, version: 2,
    sync: { closePending: 0, openPending: 0, overdue: 0, heldOpen: 0 }, reservationReads: { listings: 0, halted: 0 },
    listings: [{ listingId: "listing-a", productTitle: "合成の茶道", closePending: 0, openPending: 0, overdue: 0, reservationReads: false, readHalted: false }],
  }],
  incidents: [],
  ...patch,
});
const render = (value: ChannelRuntimeOverview) => renderToStaticMarkup(createElement(RuntimeOverviewBody, { overview: value, locked: false, onConfirm: () => undefined, send: () => undefined }));

describe("admin channel runtime panel", () => {
  it("decodes only the selected provider's overview", () => {
    expect(decodeRuntimeOverview({ overview: overview() }, "synthetic-a")?.providerId).toBe("synthetic-a");
    expect(decodeRuntimeOverview({ overview: overview() }, "synthetic-b")).toBeNull();
    expect(decodeRuntimeOverview({ overview: { ...overview(), workers: null } }, "synthetic-a")).toBeNull();
    expect(decodeRuntimeOverview({}, "synthetic-a")).toBeNull();
  });

  it("warns that a stopped Studio does not close open occurrences and never calls them stopped", () => {
    const down = overview({
      unclosedOccurrences: 3, openHold: true,
      workers: [{ id: "worker-a", displayName: "合成Studio", lastHeartbeatAtUtc: stamp, health: "DOWN", openHold: true, openHoldSinceUtc: stamp, assignedAccounts: 1 }],
    });
    expect(studioStopped(down)).toBe(true);
    const html = render(down);
    expect(html).toContain("Studio 停止中。外部で受付中の回は自動では閉じません");
    expect(html).toContain("閉じられていない回: 3件");
    expect(html).not.toContain("停止済み");
    expect(studioStopped(overview())).toBe(false);
    expect(render(overview())).not.toContain("Studio 停止中");
  });

  it("offers re-authentication only for AUTH_REQUIRED and reading restart only for a halted listing", () => {
    expect(isReauthReason("AUTH_REQUIRED")).toBe(true);
    expect(isReauthReason("MANUAL_HANDLING")).toBe(false);
    expect(isReauthReason(undefined)).toBe(false);
    const base = overview().accounts[0]!;
    const auth = render(overview({ accounts: [{ ...base, quarantineReason: "AUTH_REQUIRED", quarantinedAtUtc: stamp,
      listings: [{ ...base.listings[0]!, reservationReads: true, readHalted: true, readLastError: "READ_INCOMPLETE" }] }] }));
    expect(auth).toContain("再認証を確認して照合");
    expect(auth).toContain("停止を確認して照合");
    expect(auth).toContain("予約照合を再開");
    const manual = render(overview({ accounts: [{ ...base, quarantineReason: "MANUAL_HANDLING", quarantinedAtUtc: stamp }] }));
    expect(manual).not.toContain("再認証を確認して照合");
    expect(manual).not.toContain("停止して手動対応");
    expect(manual).toContain("停止を確認して照合");
    const healthy = render(overview());
    expect(healthy).toContain("停止して手動対応");
    expect(healthy).not.toContain("予約照合を再開");
  });

  it("lists open incidents with an ownership action unless already mine", () => {
    const html = render(overview({ watchdogStale: true, incidents: [
      { id: "1", kind: "SYNC_OVERDUE", subjectType: "account", subjectId: "account-a", openedAtUtc: stamp, escalated: true, acknowledged: false, assignedToMe: false, detail: {} },
      { id: "2", kind: "WORKER_STALE", subjectType: "worker", subjectId: "worker-a", openedAtUtc: stamp, escalated: false, acknowledged: true, assignedToMe: true, detail: {} },
    ] }));
    expect(html).toContain("反映の遅れ");
    expect(html).toContain("要対応");
    expect(html.match(/担当する/g)).toHaveLength(1);
    expect(html).toContain("担当: 自分");
    expect(html).toContain("監視が止まっています");
  });
});
