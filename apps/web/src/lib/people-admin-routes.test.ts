import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";

/** The Admin's 街の人 API (#564, #589): its gates, and that it passes only what the store checks. */
const state = vi.hoisted(() => ({
  config: { experiencePublicationsEnabled: true },
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
  csrf: true,
  load: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ peopleListingRepository: () => state.repository }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => true,
    adminMutationAllowed: () => state.csrf,
    loadAdminHttpSession: state.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});

import { DELETE, GET, PUT } from "@/app/(admin)/admin/api/people/route";

const URL_ = "https://experience.example/admin/api/people";
const PROVIDER = "prv_00000000000000000000000000000001";
const LISTING_ID = "plg_00000000000000000000000000000001";
const MEMBER = "hst_00000000000000000000000000000001";
const LISTING = { slug: "kintsugi-sato", nameJa: "佐藤", roleJa: "金継ぎ職人", areaJa: "鎌倉・長谷", quoteJa: null, introJa: "紹介", sortOrder: 10 };
const send = (method: "PUT" | "DELETE", body: unknown, headers: Record<string, string> = {}) =>
  (method === "PUT" ? PUT : DELETE)(new Request(URL_, { method, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { experiencePublicationsEnabled: true };
  state.csrf = true;
  state.repository = { adminList: vi.fn(async () => []), adminSave: vi.fn(async () => undefined), adminWithdraw: vi.fn(async () => undefined) };
  state.load.mockResolvedValue({ status: "ok", kind: "google", actor: { id: "adm_00000000000000000000000000000001", displayName: null } });
});

describe("/admin/api/people", () => {
  it("refuses a read or a change without a signed-in Admin and reads nothing for them", async () => {
    for (const status of ["signed-out", "rejected", "refresh"]) {
      state.load.mockResolvedValue({ status });
      expect((await GET(new Request(URL_))).status).toBe(401);
      expect((await send("PUT", { listingId: null, providerId: PROVIDER, memberId: MEMBER, expectedVersion: null, listing: LISTING })).status).toBe(401);
    }
    state.load.mockResolvedValue({ status: "error" });
    expect((await GET(new Request(URL_))).status).toBe(503);
    expect(state.repository!.adminList).not.toHaveBeenCalled();
    expect(state.repository!.adminSave).not.toHaveBeenCalled();
  });

  it("is a 404 while publications are off, and a change needs the same-origin check and a JSON body", async () => {
    state.config = { experiencePublicationsEnabled: false };
    expect((await GET(new Request(URL_))).status).toBe(404);
    expect((await send("PUT", { listingId: null, providerId: PROVIDER, memberId: MEMBER, expectedVersion: null, listing: LISTING })).status).toBe(404);
    state.config = { experiencePublicationsEnabled: true };
    state.csrf = false;
    expect((await send("PUT", { listingId: null, providerId: PROVIDER, memberId: MEMBER, expectedVersion: null, listing: LISTING })).status).toBe(403);
    state.csrf = true;
    expect((await PUT(new Request(URL_, { method: "PUT", headers: { "content-type": "text/plain" }, body: "x" }))).status).toBe(415);
    expect((await GET(new Request(`${URL_}?x=1`))).status).toBe(400);
    expect(state.repository!.adminSave).not.toHaveBeenCalled();
  });

  it("passes the linked experiences (#585) only when they are given, and leaves the check to the store", async () => {
    const experiences = [{ providerId: "prov-zen", productId: "zen-karate" }];
    expect((await send("PUT", { listingId: LISTING_ID, providerId: PROVIDER, memberId: MEMBER, expectedVersion: 3, listing: { ...LISTING, experiences } })).status).toBe(200);
    expect(state.repository!.adminSave).toHaveBeenLastCalledWith("adm_00000000000000000000000000000001", LISTING_ID, 3, { providerId: PROVIDER, memberId: MEMBER }, { ...LISTING, experiences });
    expect((await send("PUT", { listingId: LISTING_ID, providerId: PROVIDER, memberId: MEMBER, expectedVersion: 3, listing: { ...LISTING } })).status).toBe(200);
    expect(state.repository!.adminSave).toHaveBeenLastCalledWith("adm_00000000000000000000000000000001", LISTING_ID, 3, { providerId: PROVIDER, memberId: MEMBER }, { ...LISTING });
    state.repository!.adminSave!.mockRejectedValueOnce(new StoreNotFoundError("A linked experience was not found."));
    expect((await send("PUT", { listingId: LISTING_ID, providerId: PROVIDER, memberId: MEMBER, expectedVersion: 3, listing: { ...LISTING, experiences } })).status).toBe(404);
  });

  it("lists a person with no id and no version, and a draft with no member (memberId left out is null), and passes the photo only when given", async () => {
    expect((await send("PUT", { providerId: PROVIDER, expectedVersion: null, listing: LISTING })).status).toBe(200);
    expect(state.repository!.adminSave).toHaveBeenLastCalledWith("adm_00000000000000000000000000000001", null, null, { providerId: PROVIDER, memberId: null }, { ...LISTING });
    const photo = { assetId: "00000000-0000-4000-8000-000000000001", altJa: "写真", credit: null };
    expect((await send("PUT", { providerId: PROVIDER, memberId: MEMBER, expectedVersion: null, listing: { ...LISTING, photo } })).status).toBe(200);
    expect(state.repository!.adminSave).toHaveBeenLastCalledWith("adm_00000000000000000000000000000001", null, null, { providerId: PROVIDER, memberId: MEMBER }, { ...LISTING, photo });
    expect((await send("PUT", { providerId: PROVIDER })).status).toBe(400);
    expect((await send("PUT", { listingId: 5, providerId: PROVIDER, expectedVersion: 1, listing: LISTING })).status).toBe(400);
    expect((await send("PUT", { providerId: 7, expectedVersion: null, listing: LISTING })).status).toBe(400);
    expect((await send("PUT", { providerId: PROVIDER, memberId: 7, expectedVersion: null, listing: LISTING })).status).toBe(400);
  });

  it("lists a person with the version the Admin saw, takes them off, and maps the store's refusals", async () => {
    const ok = await send("PUT", { listingId: LISTING_ID, providerId: PROVIDER, memberId: MEMBER, expectedVersion: 3, listing: LISTING });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(state.repository!.adminSave).toHaveBeenCalledWith("adm_00000000000000000000000000000001", LISTING_ID, 3, { providerId: PROVIDER, memberId: MEMBER }, { ...LISTING });
    expect((await send("DELETE", { listingId: LISTING_ID, expectedVersion: 3 })).status).toBe(200);
    expect(state.repository!.adminWithdraw).toHaveBeenCalledWith("adm_00000000000000000000000000000001", LISTING_ID, 3);
    expect((await send("DELETE", { listingId: LISTING_ID })).status).toBe(400);
    expect((await send("PUT", { listingId: LISTING_ID, providerId: PROVIDER, expectedVersion: "3", listing: LISTING })).status).toBe(400);
    expect((await send("PUT", { listingId: null, providerId: PROVIDER, expectedVersion: null })).status).toBe(400);
    expect((await send("PUT", "not json")).status).toBe(400);
    for (const [error, status] of [[new StoreConflictError("x"), 409], [new StoreNotFoundError("x"), 404], [new StoreValidationError("x"), 400], [new Error("down"), 503]] as const) {
      state.repository!.adminSave!.mockRejectedValueOnce(error);
      expect((await send("PUT", { listingId: null, providerId: PROVIDER, memberId: MEMBER, expectedVersion: null, listing: LISTING })).status).toBe(status);
    }
  });
});
