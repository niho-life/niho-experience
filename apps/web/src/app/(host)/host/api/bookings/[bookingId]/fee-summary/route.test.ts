import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperienceFeeSummaryResponse } from "@niho-experience/api-client/fee-summary";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), load: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/fee-summary-server", () => ({ isHostFeeSummaryEnabled: mocks.enabled, loadHostFeeSummaryClient: mocks.load, hostFeeSummaryFailureJson: mocks.failure }));
vi.mock("@/lib/host/server", () => ({ hostNotFound: () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } }), noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));

import { GET } from "./route";

const upstream: ExperienceFeeSummaryResponse = { feeSummary: {
  version: "1.0.0", bookingRequestId: "b1", status: "RESULT_UNKNOWN", needsAttention: true,
  feePolicy: { supportEnabled: true, totalRateBps: 1500, originalGrossYen: 10_000, originalApplicationFeeYen: 1500, processingFeesIncluded: true, laborPaidDirectlyByHost: true },
  accounting: { successfulRefundedYen: 0, pendingRefundedYen: 0, targetTotalFeeYen: 1500, applicationFeeRefundedYen: 0, targetApplicationFeeRefundYen: 0, processingCompensatedYen: 300, targetProcessingCompensationYen: 300, hostRetainedAfterCreditsYen: 8500, netNihoCashYen: 1200 },
  reason: "FIXTURE_PRIVATE_REASON", evidenceCheckedAt: null, settledAt: null,
} };

describe("Host fee summary fixed GET BFF", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); mocks.load.mockResolvedValue({ ok: true, client: { read: vi.fn(async () => ({ ok: true, data: upstream })) } }); });
  it("returns private no-store after the sealed-session loader", async () => {
    const response = await GET(new Request("https://experience.example/host/api/bookings/b1/fee-summary"), { params: Promise.resolve({ bookingId: "b1" }) });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.load).toHaveBeenCalledOnce();
  });
  it("redacts Admin-only financial values without mutating the upstream DTO", async () => {
    const response = await GET(new Request("https://experience.example/host/api/bookings/b1/fee-summary"), { params: Promise.resolve({ bookingId: "b1" }) });
    const body = await response.json();
    expect(body.feeSummary.reason).toBeNull();
    expect(body.feeSummary.accounting).toEqual({ ...upstream.feeSummary.accounting, netNihoCashYen: null });
    expect(upstream.feeSummary.accounting?.netNihoCashYen).toBe(1200);
    expect(upstream.feeSummary.reason).toBe("FIXTURE_PRIVATE_REASON");
  });
  it("keeps preview/off closed and forbids query input", async () => {
    mocks.enabled.mockReturnValue(false); let response = await GET(new Request("https://experience.example/host/api/bookings/b1/fee-summary"), { params: Promise.resolve({ bookingId: "b1" }) }); expect(response.status).toBe(404); expect(mocks.load).not.toHaveBeenCalled();
    mocks.enabled.mockReturnValue(true); response = await GET(new Request("https://experience.example/host/api/bookings/b1/fee-summary?x=1"), { params: Promise.resolve({ bookingId: "b1" }) }); expect(response.status).toBe(400); expect(mocks.load).not.toHaveBeenCalled();
  });
});

