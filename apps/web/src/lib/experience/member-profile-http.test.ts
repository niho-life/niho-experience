import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError } from "@niho-experience/experience-store";

const context = vi.hoisted(() => ({
  host: vi.fn(), admin: vi.fn(), mutation: true,
  repository: { get: vi.fn(), save: vi.fn(), recordConsent: vi.fn(), publish: vi.fn(), saveProductSelection: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { apiMode: "http", experienceHostPublicationApiEnabled: true, experiencePublicationsEnabled: true } }));
vi.mock("@/lib/host/server", () => ({
  loadHostProvidersFresh: context.host,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/admin/server", () => ({ isAdminHttp: () => true, loadAdminHttpSession: context.admin, adminMutationAllowed: () => context.mutation }));
vi.mock("./publication-host-boundary", () => ({ publicationHostMutationAllowed: () => context.mutation }));
vi.mock("./store-server", () => ({ memberProfileRepository: () => context.repository }));

import { adminMemberProfileRequest, hostMemberProfileRequest, productMemberSelectionRequest } from "./member-profile-http";

const ref = { providerId: "provider-one", memberId: "actual-member" };
const profile = { name: "合成メンバー", ja: { intro: "合成プロフィール" }, en: null, photo: null, expectedVersion: null };
function request(path: string, method: "PUT" | "POST", body: unknown) {
  return new Request(`https://example.test${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  context.mutation = true;
  context.host.mockResolvedValue({ status: "ok", nihoUserId: ref.memberId, providers: [{ id: ref.providerId, memberRole: "COHOST" }] });
  context.admin.mockResolvedValue({ status: "ok", actor: { id: "admin-one" } });
  for (const fn of Object.values(context.repository)) fn.mockResolvedValue({});
});

describe("member profile BFF", () => {
  it("allows a cohost to save their own draft and ignores a member id in the body", async () => {
    const result = await hostMemberProfileRequest(request("/host/api/member-profiles/provider-one", "PUT", { ...profile, memberId: "somebody-else" }), ref.providerId);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(context.repository.save).toHaveBeenCalledWith(ref, profile, undefined);
    expect((await hostMemberProfileRequest(request("/host/api/member-profiles/another-provider", "PUT", profile), "another-provider")).status).toBe(403);
    expect(context.repository.save).toHaveBeenCalledTimes(1);
  });

  it("checks same-origin writes and authorizes only an OWNER for product selections", async () => {
    const path = "/host/api/products/product-one/members?providerId=provider-one";
    expect((await productMemberSelectionRequest(request(path, "PUT", { selected: [ref], expected: [] }), "product-one")).status).toBe(403);
    context.host.mockResolvedValue({ status: "ok", nihoUserId: ref.memberId, providers: [{ id: ref.providerId, memberRole: "OWNER" }] });
    context.mutation = false;
    expect((await productMemberSelectionRequest(request(path, "PUT", { selected: [ref], expected: [] }), "product-one")).status).toBe(403);
    expect(context.repository.saveProductSelection).not.toHaveBeenCalled();
    context.mutation = true;
    expect((await productMemberSelectionRequest(request(path, "PUT", { selected: [ref], expected: [] }), "product-one")).status).toBe(200);
    expect(context.repository.saveProductSelection).toHaveBeenCalledWith(ref, "product-one", [ref], []);
  });

  it("passes consent and verification as separate Admin requests and handles revoked proxy input", async () => {
    const path = "/admin/api/member-profiles/provider-one/actual-member";
    const body = { action: "recordConsent", method: "ORAL", expectedVersion: 4, profileConsent: true, photoConsent: true };
    expect((await adminMemberProfileRequest(request(path, "POST", body), ref)).status).toBe(200);
    expect(context.repository.recordConsent).toHaveBeenCalledWith(ref, 4, "admin-one", "ORAL", true);
    expect(context.repository.publish).not.toHaveBeenCalled();
    expect((await adminMemberProfileRequest(request(path, "POST", { action: "publish", expectedVersion: 4, verified: true }), ref)).status).toBe(200);
    expect(context.repository.publish).toHaveBeenCalledWith(ref, 4, true, "admin-one");
    context.repository.save.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await adminMemberProfileRequest(request(path, "PUT", profile), ref)).status).toBe(403);
  });
});
