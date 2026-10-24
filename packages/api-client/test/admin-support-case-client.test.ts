import { describe, expect, it, vi } from "vitest";
import { createExperienceAdminSupportCaseApiClient } from "../src/admin-support-case/client.ts";
import {
  decodeExperienceAdminSupportAdminListResponse,
  decodeExperienceAdminSupportCasePatchRequest,
  decodeExperienceAdminSupportCaseReadResponse,
  isExperienceAdminSupportCaseOpaqueId,
  isExperienceAdminSupportCasePathId,
} from "../src/admin-support-case/schema.ts";

const supportCase = {
  bookingRequestId: "予約.1:legacy",
  assignedAdmin: { status: "ACTIVE", id: "管理者.1:active", displayName: "合成 管理者" },
  internalMemo: "合成の内部メモ",
  revision: 2,
  createdAt: "2026-10-23T01:00:00.000Z",
  updatedAt: "2026-10-23T02:00:00.000Z",
};
const readResponse = { supportCase, writeCapability: { writable: true, reason: null } };

describe("Admin support case strict decoders", () => {
  it("counts opaque IDs as Unicode code points and keeps dots, colons and Unicode", () => {
    expect(isExperienceAdminSupportCaseOpaqueId("管理者.1:active")).toBe(true);
    expect(isExperienceAdminSupportCaseOpaqueId("😀".repeat(200))).toBe(true);
    expect(isExperienceAdminSupportCaseOpaqueId("😀".repeat(201))).toBe(false);
    expect(isExperienceAdminSupportCaseOpaqueId("\ud800")).toBe(false);
    expect(isExperienceAdminSupportCasePathId("管理者.1:active")).toBe(true);
    for (const value of [".", "..", "a/b", "a\\b", "a%2Fb", "a\0b", "\ud800"]) expect(isExperienceAdminSupportCasePathId(value)).toBe(false);
  });

  it("accepts only exact case, assignment and capability variants", () => {
    expect(decodeExperienceAdminSupportCaseReadResponse(readResponse)).toEqual(readResponse);
    expect(decodeExperienceAdminSupportCaseReadResponse({ ...readResponse, extra: true })).toBeNull();
    expect(decodeExperienceAdminSupportCaseReadResponse({ ...readResponse, supportCase: { ...supportCase, assignedAdmin: { status: "UNAVAILABLE", id: "leak" } } })).toBeNull();
    expect(decodeExperienceAdminSupportCaseReadResponse({ ...readResponse, writeCapability: { writable: false, reason: null } })).toBeNull();
    expect(decodeExperienceAdminSupportCaseReadResponse({ ...readResponse, supportCase: { ...supportCase, revision: 2_147_483_648 } })).toBeNull();
    expect(decodeExperienceAdminSupportCaseReadResponse({ ...readResponse, supportCase: { ...supportCase, internalMemo: "😀".repeat(4_001) } })).toBeNull();
  });

  it("requires a mutable patch field and rejects extras, NUL, overflow and malformed revisions", () => {
    expect(decodeExperienceAdminSupportCasePatchRequest({ expectedRevision: 2, assignedAdminUserId: "admin/opaque:1", internalMemo: "" })).toEqual({ expectedRevision: 2, assignedAdminUserId: "admin/opaque:1", internalMemo: "" });
    for (const value of [
      { expectedRevision: 2 },
      { expectedRevision: -1, internalMemo: null },
      { expectedRevision: 2_147_483_648, internalMemo: null },
      { expectedRevision: 2, internalMemo: "a\0b" },
      { expectedRevision: 2, internalMemo: "😀".repeat(4_001) },
      { expectedRevision: 2, assignedAdminUserId: "\ud800" },
      { expectedRevision: 2, internalMemo: null, extra: true },
    ]) expect(decodeExperienceAdminSupportCasePatchRequest(value)).toBeNull();
  });

  it("rejects duplicate, oversized or non-exact roster data", () => {
    expect(decodeExperienceAdminSupportAdminListResponse({ admins: [{ id: "a", displayName: null }], truncated: false })).not.toBeNull();
    expect(decodeExperienceAdminSupportAdminListResponse({ admins: [{ id: "a", displayName: null }, { id: "a", displayName: "duplicate" }], truncated: false })).toBeNull();
    expect(decodeExperienceAdminSupportAdminListResponse({ admins: Array.from({ length: 101 }, (_, index) => ({ id: `a${index}`, displayName: null })), truncated: true })).toBeNull();
  });
});

describe("Admin support case server-only client", () => {
  it("uses fixed encoded paths, Bearer, no-store and manual redirects", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(readResponse), { status: 200 }));
    const client = createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect((await client.getSupportCase("予約.1:legacy")).ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/admin/experience-bookings/%E4%BA%88%E7%B4%84.1%3Alegacy/support-case");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer token-1");
  });

  it("rejects path escapes before fetch but keeps opaque assignee IDs in JSON", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ supportCase: { ...supportCase, assignedAdmin: { status: "ACTIVE", id: "admin/opaque:1", displayName: null }, revision: 3 } }), { status: 200 }));
    const client = createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect(await client.getSupportCase("../auth")).toEqual({ ok: false, kind: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await client.patchSupportCase("予約.1:legacy", { expectedRevision: 2, assignedAdminUserId: "admin/opaque:1" });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ expectedRevision: 2, assignedAdminUserId: "admin/opaque:1" });
  });

  it("closes a booking-ID mismatch instead of returning another case", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...readResponse, supportCase: { ...supportCase, bookingRequestId: "other" } }), { status: 200 }));
    const client = createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: fetcher });
    expect(await client.getSupportCase("予約.1:legacy")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("returns only selected 409 reasons and never exposes the upstream body", async () => {
    const response = (reason: string) => new Response(JSON.stringify({ error: { code: "CONFLICT", message: "private upstream text", details: { reason, raw: "secret" } } }), { status: 409 });
    const selected = createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: vi.fn(async () => response("REVISION_CONFLICT")) });
    expect(await selected.patchSupportCase("予約.1:legacy", { expectedRevision: 2, internalMemo: null })).toEqual({ ok: false, kind: "conflict", reason: "REVISION_CONFLICT" });
    const unknown = createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: vi.fn(async () => response("PRIVATE_REASON")) });
    expect(await unknown.patchSupportCase("予約.1:legacy", { expectedRevision: 2, internalMemo: null })).toEqual({ ok: false, kind: "unexpected_response", status: 409 });
  });

  it("classifies auth, not-found, service, redirect, timeout and malformed success without fallback", async () => {
    const resultFor = async (response: Response) => {
      const client = createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: vi.fn(async () => response) });
      return client.getSupportCase("予約.1:legacy");
    };
    expect(await resultFor(new Response("{}", { status: 401 }))).toEqual({ ok: false, kind: "rejected", status: 401 });
    expect(await resultFor(new Response("{}", { status: 403 }))).toEqual({ ok: false, kind: "rejected", status: 403 });
    expect(await resultFor(new Response("{}", { status: 404 }))).toEqual({ ok: false, kind: "not_found" });
    expect(await resultFor(new Response("{}", { status: 503 }))).toEqual({ ok: false, kind: "unexpected_response", status: 503 });
    expect(await resultFor(new Response("", { status: 302 }))).toEqual({ ok: false, kind: "unexpected_response", status: 302 });
    expect(await resultFor(new Response("not-json", { status: 200 }))).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    const timeout = createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: "https://niho.example", idToken: "token-1", fetch: vi.fn(async () => { throw new Error("timeout"); }) });
    expect(await timeout.getSupportCase("予約.1:legacy")).toEqual({ ok: false, kind: "network_error" });
  });
});
