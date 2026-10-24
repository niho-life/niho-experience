import { describe, expect, it, vi } from "vitest";
import { createExperienceAdminOperationsApiClient } from "../src/admin-operations/client.ts";
import { decodeExperienceAdminOperationRequest, decodeExperienceAdminSupportOperationError, decodeExperienceAdminSupportOperationSnapshotResponse, isExperienceAdminOperationsPathId } from "../src/admin-operations/schema.ts";

const operationId = "123e4567-e89b-42d3-a456-426614174000";
const operation = { operationId, bookingRequestId: "booking.1", action: "MESSAGE", actorKind: "NIHO_SUPPORT", expectedRevision: 3, expectedStatus: "CONFIRMED", expectedTotalYen: 10000, expectedRefundedYen: 0, expectedProviderRefundedYen: null, requestedRefundAmountYen: null, reasonCode: "BOOKING_DETAILS", state: "UNKNOWN", resultCode: null, resultStatus: null, resultRefundedYen: null, message: { messageId: null, subject: null, body: null, retained: false, deliveryStatus: null }, retryAllowed: false, firstExternalAttemptAt: "2026-10-23T01:00:00.000Z", lastReconciledAt: null, createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T01:01:00.000Z", completedAt: null };
const booking = { bookingRequestId: "booking.1", revision: 3, updatedAt: "2026-10-23T01:00:00.000Z", host: { kind: "EXPERIENCE_PROVIDER", id: "provider.1", displayName: "合成ホスト", vesselSpotId: "spot.1" }, guest: { displayName: "合成予約者" }, status: "CONFIRMED", totalYen: 10000, refundedYen: 0, providerRefund: { status: "KNOWN", refundedYen: 0, observedAt: "2026-10-23T01:00:00.000Z" }, refundOptions: [{ choice: "FULL", refundAmountYen: 10000, resultRefundedYen: 10000 }, { choice: "NONE", refundAmountYen: 0, resultRefundedYen: 0 }], occurrenceDate: "2026-11-01", startAt: "2026-11-01T09:00:00+09:00", endAt: "2026-11-01T11:00:00+09:00", approvalDeadlineAt: null, actions: { approve: { allowed: false, reason: "STATUS" }, decline: { allowed: false, reason: "STATUS" }, cancel: { allowed: true, reason: null }, message: { allowed: true, reason: null } } };
const snapshot = { booking, operations: [operation], history: { limit: 50, truncated: false } };

describe("Admin operations strict SDK", () => {
  it("rejects extra keys, invalid UUID v4 and wrong nested shapes", () => {
    expect(decodeExperienceAdminSupportOperationSnapshotResponse(snapshot)).not.toBeNull();
    expect(decodeExperienceAdminSupportOperationSnapshotResponse({ ...snapshot, private: true })).toBeNull();
    expect(decodeExperienceAdminSupportOperationSnapshotResponse({ ...snapshot, booking: { ...booking, stripeId: "secret" } })).toBeNull();
    expect(decodeExperienceAdminSupportOperationSnapshotResponse({ ...snapshot, booking: { ...booking, occurrenceDate: [booking.occurrenceDate] } })).toBeNull();
    expect(decodeExperienceAdminOperationRequest("MESSAGE", { operationId, expectedRevision: 3, expectedStatus: "CONFIRMED", expectedTotalYen: 10000, expectedRefundedYen: 0, reasonCode: "BOOKING_DETAILS", subject: "確認", body: "合成本文" })).not.toBeNull();
    expect(decodeExperienceAdminOperationRequest("MESSAGE", { operationId: "123e4567-e89b-12d3-a456-426614174000", expectedRevision: 3, expectedStatus: "CONFIRMED", expectedTotalYen: 10000, expectedRefundedYen: 0, reasonCode: "BOOKING_DETAILS", subject: "確認", body: "合成本文" })).toBeNull();
  });

  it("counts path IDs by Unicode code point and strictly decodes selected errors", () => {
    expect(isExperienceAdminOperationsPathId("😀".repeat(200))).toBe(true);
    expect(isExperienceAdminOperationsPathId("😀".repeat(201))).toBe(false);
    expect(decodeExperienceAdminSupportOperationSnapshotResponse({ ...snapshot, booking: { ...booking, host: { ...booking.host, id: "😀".repeat(200), vesselSpotId: "😀".repeat(200) } } })).not.toBeNull();
    expect(decodeExperienceAdminSupportOperationSnapshotResponse({ ...snapshot, booking: { ...booking, host: { ...booking.host, id: "😀".repeat(201) } } })).toBeNull();
    expect(decodeExperienceAdminSupportOperationSnapshotResponse({ ...snapshot, booking: { ...booking, host: { ...booking.host, vesselSpotId: "😀".repeat(201) } } })).toBeNull();
    const error = { error: { code: "CONFLICT", message: "更新されています", details: { reason: "REVISION_CONFLICT" } } };
    expect(decodeExperienceAdminSupportOperationError(error)).toEqual(error);
    expect(decodeExperienceAdminSupportOperationError({ ...error, private: true })).toBeNull();
    expect(decodeExperienceAdminSupportOperationError({ error: { ...error.error, traceId: "private" } })).toBeNull();
  });

  it("uses Bearer/no-store/manual redirect and checks booking/operation IDs", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(snapshot));
    const client = createExperienceAdminOperationsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: fetcher });
    expect((await client.getSnapshot("booking.1")).ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/admin/experience-bookings/booking.1/support-operations");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer admin-token");
    const wrong = createExperienceAdminOperationsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: vi.fn(async () => Response.json({ ...snapshot, booking: { ...booking, bookingRequestId: "other" } })) });
    expect(await wrong.getSnapshot("booking.1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("posts only a validated immutable command and rejects mismatched response IDs", async () => {
    const command = { operationId, expectedRevision: 3, expectedStatus: "CONFIRMED" as const, expectedTotalYen: 10000, expectedRefundedYen: 0, reasonCode: "BOOKING_DETAILS" as const, subject: "確認", body: "合成本文" };
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ operation }));
    const client = createExperienceAdminOperationsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: fetcher });
    expect((await client.execute("booking.1", "MESSAGE", command)).ok).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(command);
    const wrong = createExperienceAdminOperationsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: vi.fn(async () => Response.json({ operation: { ...operation, operationId: "223e4567-e89b-42d3-a456-426614174000" } })) });
    expect(await wrong.execute("booking.1", "MESSAGE", command)).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("distinguishes explicit unaccepted conflicts from reused or unknown operation IDs", async () => {
    const command = { operationId, expectedRevision: 3, expectedStatus: "CONFIRMED" as const, expectedTotalYen: 10000, expectedRefundedYen: 0, reasonCode: "BOOKING_DETAILS" as const, subject: "確認", body: "合成本文" };
    const response = (reason: string, details: Record<string, unknown> = { reason }) => new Response(JSON.stringify({ error: { code: "CONFLICT", message: "更新されています", details } }), { status: 409, headers: { "content-type": "application/json" } });
    const client = (reason: string, details?: Record<string, unknown>) => createExperienceAdminOperationsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: vi.fn(async () => response(reason, details)) });
    expect(await client("REVISION_CONFLICT").execute("booking.1", "MESSAGE", command)).toEqual({ ok: false, kind: "conflict", reason: "REVISION_CONFLICT" });
    expect(await client("OPERATION_ID_REUSED").execute("booking.1", "MESSAGE", command)).toEqual({ ok: false, kind: "operation_id_reused" });
    expect(await client("FUTURE_CONFLICT").execute("booking.1", "MESSAGE", command)).toEqual({ ok: false, kind: "unexpected_response", status: 409 });
    expect(await client("REVISION_CONFLICT", { reason: "REVISION_CONFLICT", private: true }).execute("booking.1", "MESSAGE", command)).toEqual({ ok: false, kind: "unexpected_response", status: 409 });
  });
});
