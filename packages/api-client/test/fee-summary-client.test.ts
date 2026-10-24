import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decodeExperienceFeeSummaryResponse, isExperienceFeeSummaryBookingId } from "../src/fee-summary/index.ts";
import { createExperienceFeeSummaryApiClient } from "../src/fee-summary/server.ts";

const policy = { supportEnabled: true, totalRateBps: 1500, originalGrossYen: 12_000, originalApplicationFeeYen: 1_800, processingFeesIncluded: true, laborPaidDirectlyByHost: true };
const accounting = { successfulRefundedYen: 2_000, pendingRefundedYen: 0, targetTotalFeeYen: 1_500, applicationFeeRefundedYen: 300, targetApplicationFeeRefundYen: 300, processingCompensatedYen: 100, targetProcessingCompensationYen: 100, hostRetainedAfterCreditsYen: 8_900, netNihoCashYen: 1_100 };
const response = { feeSummary: { version: "1.0.0", bookingRequestId: "booking.1", status: "SETTLED", feePolicy: policy, accounting, needsAttention: false, reason: null, evidenceCheckedAt: "2026-10-23T01:00:00.000Z", settledAt: "2026-10-23T01:01:00.000Z" } };

describe("fee summary strict browser decoder", () => {
  it("keeps null distinct from zero, accepts signed balances and unbounded contract text", () => {
    const longReason = "確認".repeat(20_000);
    const value = { feeSummary: { ...response.feeSummary, reason: longReason, accounting: { ...accounting, successfulRefundedYen: null, pendingRefundedYen: 0, targetTotalFeeYen: 4_000_000_000, hostRetainedAfterCreditsYen: -500, netNihoCashYen: -200 } } };
    const decoded = decodeExperienceFeeSummaryResponse(value);
    expect(decoded?.feeSummary.accounting).toMatchObject({ successfulRefundedYen: null, pendingRefundedYen: 0, targetTotalFeeYen: 4_000_000_000, hostRetainedAfterCreditsYen: -500, netNihoCashYen: -200 });
    expect(decoded?.feeSummary.reason).toBe(longReason);
  });

  it("rejects extras, malformed values and unsafe IDs without inventing DTO limits", () => {
    expect(decodeExperienceFeeSummaryResponse({ ...response, privateField: true })).toBeNull();
    expect(decodeExperienceFeeSummaryResponse({ feeSummary: { ...response.feeSummary, accounting: { ...accounting, pendingRefundedYen: -1 } } })).toBeNull();
    expect(decodeExperienceFeeSummaryResponse({ feeSummary: { ...response.feeSummary, feePolicy: { ...policy, totalRateBps: 1200 } } })).toBeNull();
    expect(isExperienceFeeSummaryBookingId("😀".repeat(200))).toBe(true);
    expect(isExperienceFeeSummaryBookingId("😀".repeat(201))).toBe(false);
    expect(isExperienceFeeSummaryBookingId("a/b")).toBe(false);
  });
});

describe("fee summary server-only client", () => {
  it.each([
    ["admin", "https://niho.example/api/admin/experience-bookings/booking.1/fee-summary"],
    ["host", "https://niho.example/api/experience-providers/management/bookings/booking.1/fee-summary"],
  ] as const)("uses the fixed %s GET with Bearer, no-store and manual redirects", async (audience, expectedUrl) => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(response));
    const client = createExperienceFeeSummaryApiClient({ nihoWebOrigin: "https://niho.example", idToken: "server-token", audience, fetch: fetcher });
    expect((await client.read("booking.1")).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ method: "GET", cache: "no-store", redirect: "manual" }));
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer server-token");
  });

  it("rejects wrong booking IDs and maps auth/not-found/network without a success fallback", async () => {
    const wrong = createExperienceFeeSummaryApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token", audience: "admin", fetch: vi.fn(async () => Response.json({ feeSummary: { ...response.feeSummary, bookingRequestId: "other" } })) });
    expect(await wrong.read("booking.1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    const rejected = createExperienceFeeSummaryApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token", audience: "host", fetch: vi.fn(async () => Response.json({}, { status: 403 })) });
    expect(await rejected.read("booking.1")).toEqual({ ok: false, kind: "rejected", status: 403 });
    const network = createExperienceFeeSummaryApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token", audience: "host", fetch: vi.fn(async () => { throw new Error("offline"); }) });
    expect(await network.read("booking.1")).toEqual({ ok: false, kind: "network_error" });
    expect(await wrong.read("bad/id")).toEqual({ ok: false, kind: "invalid_request" });
  });
});
