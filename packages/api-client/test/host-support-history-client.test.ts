import { describe, expect, it, vi } from "vitest";
import { createExperienceHostSupportHistoryApiClient } from "../src/host-support-history/client.ts";
import { decodeExperienceHostSupportHistoryDetailResponse, decodeExperienceHostSupportHistoryResponse, isExperienceHostSupportHistoryPathId } from "../src/host-support-history/schema.ts";
const operationId = "123e4567-e89b-42d3-a456-426614174000";
const item = { operationId, bookingRequestId: "booking.1", action: "MESSAGE", actorKind: "NIHO_SUPPORT", reasonCode: "BOOKING_DETAILS", state: "SUCCEEDED", resultCode: "SENT", resultStatus: "CONFIRMED", resultRefundedYen: null, hasMessage: true, createdAt: "2026-10-23T01:00:00.000Z", completedAt: "2026-10-23T01:01:00.000Z" };
const list = { bookingRequestId: "booking.1", operations: [item], history: { limit: 50, truncated: false } };
const { hasMessage: _hasMessage, ...detailBase } = item;
const detail = { operation: { ...detailBase, communication: { messageId: null, subject: null, body: null, retained: false, deliveryStatus: null } } };

describe("Host support history strict SDK", () => {
  it("keeps retention null typed and rejects internal/private extras", () => {
    expect(decodeExperienceHostSupportHistoryResponse(list)).not.toBeNull();
    expect(decodeExperienceHostSupportHistoryDetailResponse(detail)?.operation.communication).toEqual({ messageId: null, subject: null, body: null, retained: false, deliveryStatus: null });
    expect(decodeExperienceHostSupportHistoryResponse({ ...list, internalMemo: "leak" })).toBeNull();
    expect(decodeExperienceHostSupportHistoryDetailResponse({ operation: { ...detail.operation, payloadHash: "leak" } })).toBeNull();
  });

  it("counts host booking IDs by Unicode code point", () => {
    expect(isExperienceHostSupportHistoryPathId("😀".repeat(200))).toBe(true);
    expect(isExperienceHostSupportHistoryPathId("😀".repeat(201))).toBe(false);
  });

  it("uses the fixed host subtree, Bearer/no-store and rejects wrong IDs", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(list));
    const client = createExperienceHostSupportHistoryApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: fetcher });
    expect((await client.list("booking.1")).ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/experience-providers/management/bookings/booking.1/support-history");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer host-token");
    const wrong = createExperienceHostSupportHistoryApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: vi.fn(async () => Response.json({ ...list, bookingRequestId: "other" })) });
    expect(await wrong.list("booking.1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });
});
