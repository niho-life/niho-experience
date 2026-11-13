import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";

const state = vi.hoisted(() => ({
  http: true,
  mutation: true,
  load: vi.fn(),
  repository: { adminList: vi.fn(), adminRead: vi.fn(), adminSave: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => state.http,
    adminMutationAllowed: () => state.mutation,
    loadAdminHttpSession: state.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});
vi.mock("@/lib/experience/store-server", () => ({ productClassificationRepository: () => state.repository }));

import { GET, PUT } from "./route";

const URL = "https://experience.example/admin/api/product-classifications";
const value = { category: "walk", area: "kita", companions: ["solo"], occasions: [] };
const put = (body: unknown) => new Request(URL, { method: "PUT", headers: { "content-type": "application/json", origin: URL, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  state.http = true; state.mutation = true;
  state.load.mockResolvedValue({ status: "ok", actor: { id: "admin-synthetic" } });
});

describe("Admin product classifications (#529)", () => {
  it("is not found outside the Admin HTTP mode and refuses without an Admin", async () => {
    state.http = false;
    expect((await GET(new Request(URL))).status).toBe(404);
    state.http = true; state.load.mockResolvedValue({ status: "signed-out" });
    expect((await GET(new Request(URL))).status).toBe(401);
    expect((await PUT(put({ items: [] }))).status).toBe(401);
    expect(state.repository.adminList).not.toHaveBeenCalled();
  });

  it("lists every product and reads one", async () => {
    state.repository.adminList.mockResolvedValue([]);
    expect(await (await GET(new Request(URL))).json()).toEqual({ products: [] });
    state.repository.adminRead.mockResolvedValue(value);
    expect(await (await GET(new Request(`${URL}?providerId=p1&productId=x1`))).json()).toEqual({ classification: value });
    expect((await GET(new Request(`${URL}?providerId=p1`))).status).toBe(400);
    state.repository.adminRead.mockRejectedValueOnce(new StoreNotFoundError("product"));
    expect((await GET(new Request(`${URL}?providerId=p1&productId=nope`))).status).toBe(404);
  });

  it("saves many at once as the office, and refuses a forged, malformed or cross-site request", async () => {
    state.repository.adminSave.mockResolvedValue(2);
    const items = [{ providerId: "p1", productId: "a", classification: value }, { providerId: "p1", productId: "b", classification: value }];
    expect(await (await PUT(put({ items }))).json()).toEqual({ saved: 2 });
    expect(state.repository.adminSave).toHaveBeenCalledWith({ nihoUserId: "admin-synthetic" }, items);
    expect((await PUT(put({ items, extra: 1 }))).status).toBe(400);
    expect((await PUT(put({ items: [{ providerId: "p1", productId: "a" }] }))).status).toBe(400);
    expect((await PUT(put({ items: [{ ...items[0], updatedBy: "x" }] }))).status).toBe(400);
    state.repository.adminSave.mockRejectedValueOnce(new StoreValidationError("bad"));
    expect((await PUT(put({ items }))).status).toBe(400);
    state.mutation = false;
    expect((await PUT(put({ items }))).status).toBe(403);
  });
});
