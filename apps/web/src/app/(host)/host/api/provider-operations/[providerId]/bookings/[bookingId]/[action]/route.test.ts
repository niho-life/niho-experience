import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), approve: vi.fn(), decline: vi.fn(), message: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
  decodeExperienceProviderMessageInput: (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const input = value as Record<string, unknown>;
    return typeof input.subject === "string" && input.subject.length > 0 && typeof input.body === "string" && input.body.length > 0
      ? { subject: input.subject, body: input.body }
      : null;
  },
}));
vi.mock("@/lib/host/provider-operations-server", () => ({
  providerOperationsMutationAllowed: mocks.allowed,
  loadProviderOperationsClient: mocks.load,
  readProviderOperationsJson: async (request: Request, maxBytes: number) => {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false };
    try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
  },
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  providerOperationsFailure: mocks.failure,
}));

import { POST } from "./route";

const context = (action: string) => ({ params: Promise.resolve({ providerId: "provider_1", bookingId: "booking_1", action }) });
const request = (body: unknown, origin = "https://experience.example") => new Request("https://experience.example/host/api/provider-operations/provider_1/bookings/booking_1/action", {
  method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("provider booking action BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allowed.mockReturnValue(true);
    mocks.approve.mockResolvedValue({ ok: true, data: { status: "CONFIRMED" } });
    mocks.decline.mockResolvedValue({ ok: true, data: { status: "DECLINED" } });
    mocks.message.mockResolvedValue({ ok: true, data: { message: { id: "m1", subject: "確認", createdAt: "2026-10-27T00:00:00.000Z", sentAt: null, failed: false, deliveryStatus: "QUEUED" } } });
    mocks.load.mockResolvedValue({ ok: true, client: { approveBooking: mocks.approve, declineBooking: mocks.decline, messageGuest: mocks.message } });
    mocks.failure.mockImplementation(() => Response.json({ error: "upstream" }, { status: 502 }));
  });

  it("allows only approve, decline and message; never cancel/refund/financial operations", async () => {
    expect((await POST(request({ pageId: "page_1" }), context("approve"))).status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith("provider_1", "page_1", "booking_1");
    expect((await POST(request({ pageId: "page_1" }), context("decline"))).status).toBe(200);
    expect(mocks.decline).toHaveBeenCalledWith("provider_1", "page_1", "booking_1");
    for (const action of ["cancel", "refund", "payout", "approve/../../refund"]) {
      expect((await POST(request({ pageId: "page_1" }), context(action))).status).toBe(404);
    }
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("requires same-origin and exact action-specific bodies", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await POST(request({ pageId: "page_1" }, "https://evil.example"), context("approve"))).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect((await POST(request({ pageId: "page_1", refund: "FULL" }), context("approve"))).status).toBe(400);
    expect((await POST(request({ pageId: "../private" }), context("decline"))).status).toBe(400);
    expect((await POST(request({ pageId: "page_1", subject: "確認", body: "合成の本文", stripeRefundId: "hidden" }), context("message"))).status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.decline).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("sends only pageId, subject and body for a reply", async () => {
    const response = await POST(request({ pageId: "page_1", subject: "確認", body: "合成の本文" }), context("message"));
    expect(response.status).toBe(201);
    expect(mocks.message).toHaveBeenCalledWith("provider_1", "page_1", "booking_1", { subject: "確認", body: "合成の本文" });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
