import { describe, expect, it, vi } from "vitest";
import { createExperienceAdminReadApiClient } from "../src/admin-read/client.ts";
import {
  decodeExperienceAdminBookingDetailResponse,
  decodeExperienceAdminBookingListResponse,
  decodeExperienceAdminNotificationListResponse,
} from "../src/admin-read/schema.ts";

const validSupport = {
  kind: "valid",
  snapshot: {
    policyVersion: "2026-10-23",
    enabled: true,
    baseRateBps: 1000,
    supportRateBps: 500,
    totalRateBps: 1500,
    consentVersion: "2026-10-23",
    consentedAt: "2026-10-23T01:00:00.000Z",
    consentedByUserId: "user-1",
    agreementRevision: 2,
  },
  normalOperationsAllowed: true,
};

const listItem = {
  id: "booking-1",
  host: { kind: "EXPERIENCE_PROVIDER", id: "provider-1", displayName: "サンプル工房", vesselSpotId: "spot-vessel" },
  pageId: "page-1",
  experienceTitle: "藍染め体験",
  offerName: "午前",
  occurrenceDate: "2026-11-03",
  startAt: "2026-11-03T01:00:00.000Z",
  endAt: "2026-11-03T03:00:00.000Z",
  headCount: 2,
  totalYen: 12000,
  guestName: "Synthetic Guest",
  status: "PENDING",
  support: validSupport,
  needsAttention: true,
  createdAt: "2026-10-23T01:00:00.000Z",
};

const detail = {
  id: listItem.id,
  host: listItem.host,
  pageId: listItem.pageId,
  occurrenceDate: listItem.occurrenceDate,
  startAt: listItem.startAt,
  endAt: listItem.endAt,
  headCount: listItem.headCount,
  totalYen: listItem.totalYen,
  guestName: listItem.guestName,
  status: listItem.status,
  support: listItem.support,
  createdAt: listItem.createdAt,
  offerId: "offer-1",
  offerName: "午前",
  adultCount: 2,
  childCount: 0,
  guestEmail: "",
  languageSnapshot: "en",
  note: null,
  answers: null,
  unitPriceYen: 6000,
  adultPriceYen: 6000,
  childPriceYen: null,
  paidAt: null,
  authorizedAt: "2026-10-23T01:01:00.000Z",
  approvalDeadlineAt: "2026-10-24T01:00:00.000Z",
  travelerCancelRequestedAt: null,
  cancelledAt: null,
  cancelReason: null,
  cancelMessage: null,
  refundedYen: 0,
  salesChannel: "EXPERIENCE_SITE_FUTURE_VALUE",
  hostMessages: [{ id: "message-1", subject: "Application received", createdAt: "2026-10-23T01:00:00.000Z", sentAt: null, failed: false, deliveryStatus: "QUEUED" }],
  page: { title: "藍染め体験" },
};

describe("Admin read response decoders", () => {
  it("keeps provider identity, unknown language/channel strings and valid support snapshot", () => {
    expect(decodeExperienceAdminBookingListResponse({ bookings: [listItem], nextCursor: "cursor-2" }))?.toMatchObject({ bookings: [{ host: { kind: "EXPERIENCE_PROVIDER", id: "provider-1" } }] });
    expect(decodeExperienceAdminBookingDetailResponse({ booking: detail, supportAgreement: { agreementRevision: 2, sharedConsultationMemo: null, matchesBookingSnapshot: true } }))?.toMatchObject({ booking: { guestEmail: "", languageSnapshot: "en", salesChannel: "EXPERIENCE_SITE_FUTURE_VALUE" } });
  });

  it("rejects invalid support combinations and malformed 2xx bodies", () => {
    const bad = { ...listItem, support: { ...validSupport, snapshot: { ...validSupport.snapshot, enabled: false } } };
    expect(decodeExperienceAdminBookingListResponse({ bookings: [bad], nextCursor: null })).toBeNull();
    expect(decodeExperienceAdminBookingListResponse({ bookings: [listItem], nextCursor: null, extra: true })).toBeNull();
    expect(decodeExperienceAdminBookingDetailResponse({ booking: { ...detail, adultCount: 1 }, supportAgreement: { agreementRevision: 2, sharedConsultationMemo: null, matchesBookingSnapshot: true } })).toBeNull();
    expect(decodeExperienceAdminBookingDetailResponse({ booking: detail, supportAgreement: { agreementRevision: 99, sharedConsultationMemo: null, matchesBookingSnapshot: true } })).toBeNull();
  });

  it("accepts opaque response IDs without imposing URL-segment character rules", () => {
    const item = { ...listItem, id: "booking.1:legacy", host: { ...listItem.host, id: "provider:legacy.1" }, support: { ...validSupport, snapshot: { ...validSupport.snapshot, consentedByUserId: "federated:owner.user" } } };
    expect(decodeExperienceAdminBookingListResponse({ bookings: [item], nextCursor: null }))?.toMatchObject({ bookings: [{ id: item.id, host: { id: item.host.id }, support: { snapshot: { consentedByUserId: "federated:owner.user" } } }] });
    expect(decodeExperienceAdminNotificationListResponse({ notifications: [{ id: "notice:1.v2", type: "APPLICATION_RECEIVED", title: "合成通知", body: "通知", bookingRequestId: item.id, occurredAt: item.createdAt, readAt: null }], unreadCount: 1, nextCursor: null })).not.toBeNull();
  });

  it("accepts seven notification types and does not equate page unread with global unread", () => {
    const notifications = ["APPLICATION_RECEIVED", "BOOKING_CONFIRMED", "BOOKING_DECLINED", "BOOKING_EXPIRED", "BOOKING_CANCELLED", "REFUND_NEEDED", "TRAVELER_CANCEL_REQUESTED"].map((type, index) => ({ id: `notice-${index}`, type, title: type, body: "合成通知", bookingRequestId: "booking-1", occurredAt: "2026-10-23T01:00:00.000Z", readAt: index === 0 ? null : "2026-10-23T02:00:00.000Z" }));
    expect(decodeExperienceAdminNotificationListResponse({ notifications, unreadCount: 12, nextCursor: null }))?.toMatchObject({ unreadCount: 12 });
    expect(decodeExperienceAdminNotificationListResponse({ notifications: [{ ...notifications[0], type: "NEW_CONTACT" }], unreadCount: 1, nextCursor: null })).toBeNull();
    expect(decodeExperienceAdminNotificationListResponse({ notifications: [{ ...notifications[1], occurredAt: "2026-10-23T01:00:00.000Z" }, { ...notifications[0], occurredAt: "2026-10-23T02:00:00.000Z" }], unreadCount: 1, nextCursor: null })).toBeNull();
  });
});

describe("Admin read server-only client", () => {
  it("uses the POST query path and never puts search terms in its URL", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ bookings: [listItem], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    const result = await client.queryBookings({ hostSearch: "工房", search: "Synthetic Guest", limit: 50 });
    expect(result.ok).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    if (!init) throw new Error("request init was missing");
    expect(url).toBe("https://niho.example/api/admin/experience-bookings/query");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ hostSearch: "工房", search: "Synthetic Guest", limit: 50 });
    expect(init).toMatchObject({ cache: "no-store", redirect: "manual" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
  });

  it("uses fixed paths, rejects opaque path escapes, and closes 401/403", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response("{}", { status: 403 }));
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect(await client.getBooking("../auth")).toEqual({ ok: false, kind: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await client.getBooking("booking-1")).toEqual({ ok: false, kind: "rejected", status: 403 });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/admin/experience-bookings/booking-1");
  });

  it("encodes opaque path IDs while keeping traversal outside the fixed route", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ booking: { ...detail, id: "booking.1:legacy" }, supportAgreement: { agreementRevision: 2, sharedConsultationMemo: null, matchesBookingSnapshot: true } }), { status: 200 }));
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    for (const id of [".", "..", "a/b", "a\\b", "a%2Fb", "a%5Cb", "a%2Eb", "", "x".repeat(201), "\ud800"]) {
      expect(await client.getBooking(id)).toEqual({ ok: false, kind: "invalid_request" });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await client.getBooking("booking.1:legacy")).ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/admin/experience-bookings/booking.1%3Alegacy");
  });

  it("keeps opaque notification IDs in the JSON body and accepts the exact receipt", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ notifications: [{ id: "notice:1.v2", readAt: "2026-10-23T01:00:00.000Z" }], unreadCount: 2 }), { status: 200 }));
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect((await client.markNotificationsRead({ notificationIds: ["notice:1.v2"] })).ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/admin/experience-support-notifications/read");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ notificationIds: ["notice:1.v2"] });
  });

  it("rejects malformed success JSON", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ bookings: [{ ...listItem, status: "UNKNOWN" }], nextCursor: null }), { status: 200 }));
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect(await client.queryBookings({ limit: 50 })).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("rejects malformed notification queries without throwing or fetching", async () => {
    const fetcher = vi.fn();
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    const malformed = [
      undefined,
      { unread: "true" },
      { cursor: 42 },
      { cursor: "next", unknown: true },
    ];
    for (const query of malformed) {
      await expect(client.listNotifications(query as never)).resolves.toEqual({ ok: false, kind: "invalid_request" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies invalid 2xx JSON as an unexpected response rather than an empty result", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response("not-json", { status: 200 }));
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect(await client.queryBookings({})).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("rejects partial read receipts without accepting the returned unread count", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ notifications: [{ id: "notice-1", readAt: "2026-10-23T01:00:00.000Z" }], unreadCount: 0 }), { status: 200 }));
    const client = createExperienceAdminReadApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect(await client.markNotificationsRead({ notificationIds: ["notice-1", "notice-2"] })).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });
});
