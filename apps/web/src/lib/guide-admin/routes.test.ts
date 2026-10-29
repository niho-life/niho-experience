import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    guideAdminApiEnabled: true,
    guideAdminAudience: "https://experience.example/internal/guide-admin",
    guideAdminServiceAccountEmail: "guide-admin@example.iam.gserviceaccount.com",
  },
  verifyIdToken: vi.fn(),
  repositoryFactory: vi.fn(),
  repository: {
    getWriterGrant: vi.fn(),
    putWriterGrant: vi.fn(),
    listCategories: vi.fn(),
    putCategory: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({ guideAdminRepository: mocks.repositoryFactory }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));

import { GET as getWriter, PUT as putWriter } from "@/app/internal/guide-admin/v1/writers/[nihoUserId]/route";
import { GET as listCategories } from "@/app/internal/guide-admin/v1/categories/route";
import { PUT as putCategory } from "@/app/internal/guide-admin/v1/categories/[slug]/route";

const SITE = "https://experience.example";
const authHeaders = { authorization: "Bearer synthetic.jwt.token" };
const mutationHeaders = {
  ...authHeaders,
  "content-type": "application/json",
  "idempotency-key": "00000000-0000-4000-8000-000000000001",
  "x-niho-admin-actor-id": "admin-synthetic",
};
const writerContext = { params: Promise.resolve({ nihoUserId: "writer-synthetic" }) };
const categoryContext = { params: Promise.resolve({ slug: "culture" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.guideAdminApiEnabled = true;
  mocks.repositoryFactory.mockReturnValue(mocks.repository);
  mocks.verifyIdToken.mockResolvedValue({
    getPayload: () => ({
      iss: "https://accounts.google.com",
      aud: mocks.config.guideAdminAudience,
      email: mocks.config.guideAdminServiceAccountEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      sub: "service-synthetic",
    }),
  });
  mocks.repository.getWriterGrant.mockResolvedValue({ nihoUserId: "writer-synthetic", active: false, sourceVersion: 0 });
  mocks.repository.putWriterGrant.mockResolvedValue({
    status: "APPLIED",
    writer: {
      nihoUserId: "writer-synthetic",
      active: true,
      sourceVersion: 1,
      sourceInvitationId: "00000000-0000-4000-8000-000000000101",
    },
  });
  mocks.repository.listCategories.mockResolvedValue([
    { slug: "culture", labelEn: "Culture", labelJa: "文化", displayOrder: 10, active: false, revision: 2 },
  ]);
  mocks.repository.putCategory.mockResolvedValue({
    status: "APPLIED",
    category: { slug: "culture", labelEn: "Culture", labelJa: "文化", displayOrder: 10, active: true, revision: 3 },
  });
});

describe("guide admin internal routes", () => {
  it("returns 404 before auth and database when the independent flag is off", async () => {
    mocks.config.guideAdminApiEnabled = false;
    const response = await getWriter(new Request(`${SITE}/internal/guide-admin/v1/writers/writer-synthetic`), writerContext);
    expect(response.status).toBe(404);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.repositoryFactory).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("authenticates every GET before returning one grant or all category revisions", async () => {
    const writer = await getWriter(new Request(`${SITE}/internal/guide-admin/v1/writers/writer-synthetic`, { headers: authHeaders }), writerContext);
    const categories = await listCategories(new Request(`${SITE}/internal/guide-admin/v1/categories`, { headers: authHeaders }));
    expect(writer.status).toBe(200);
    expect(await writer.json()).toEqual({ writer: { nihoUserId: "writer-synthetic", active: false, sourceVersion: 0 } });
    expect(await categories.json()).toEqual({ categories: [
      { slug: "culture", labelEn: "Culture", labelJa: "文化", displayOrder: 10, active: false, revision: 2 },
    ] });
    expect(mocks.verifyIdToken).toHaveBeenCalledTimes(2);
    expect(mocks.repository.getWriterGrant).toHaveBeenCalledWith("writer-synthetic");
    expect(mocks.repository.listCategories).toHaveBeenCalledOnce();

    mocks.verifyIdToken.mockRejectedValueOnce(new Error("invalid signature"));
    const denied = await listCategories(new Request(`${SITE}/internal/guide-admin/v1/categories`, { headers: authHeaders }));
    expect(denied.status).toBe(401);
    expect(mocks.repository.listCategories).toHaveBeenCalledOnce();
  });

  it("passes only strict writer commands and maps version/idempotency conflicts", async () => {
    const body = { active: true, sourceVersion: 1, sourceInvitationId: "00000000-0000-4000-8000-000000000101" };
    const response = await putWriter(new Request(`${SITE}/internal/guide-admin/v1/writers/writer-synthetic`, {
      method: "PUT", headers: mutationHeaders, body: JSON.stringify(body),
    }), writerContext);
    expect(response.status).toBe(200);
    expect(mocks.repository.putWriterGrant).toHaveBeenCalledWith(
      { idempotencyKey: mutationHeaders["idempotency-key"], actorNihoUserId: "admin-synthetic" },
      "writer-synthetic",
      body,
    );

    mocks.repository.putWriterGrant.mockResolvedValueOnce({ status: "CONFLICT", reason: "SOURCE_VERSION" });
    const conflict = await putWriter(new Request(`${SITE}/internal/guide-admin/v1/writers/writer-synthetic`, {
      method: "PUT", headers: mutationHeaders, body: JSON.stringify(body),
    }), writerContext);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict", reason: "source_version" });

    const extra = await putWriter(new Request(`${SITE}/internal/guide-admin/v1/writers/writer-synthetic`, {
      method: "PUT", headers: mutationHeaders, body: JSON.stringify({ ...body, email: "must-not-pass@example.test" }),
    }), writerContext);
    expect(extra.status).toBe(400);
    const query = await putWriter(new Request(`${SITE}/internal/guide-admin/v1/writers/writer-synthetic?force=true`, {
      method: "PUT", headers: mutationHeaders, body: JSON.stringify(body),
    }), writerContext);
    expect(query.status).toBe(400);
  });

  it("passes category compare-and-set commands and returns private conflict responses", async () => {
    const body = { labelEn: "Culture", labelJa: "文化", displayOrder: 10, active: true, expectedRevision: 2 };
    const response = await putCategory(new Request(`${SITE}/internal/guide-admin/v1/categories/culture`, {
      method: "PUT", headers: mutationHeaders, body: JSON.stringify(body),
    }), categoryContext);
    expect(response.status).toBe(200);
    expect(mocks.repository.putCategory).toHaveBeenCalledWith(
      { idempotencyKey: mutationHeaders["idempotency-key"], actorNihoUserId: "admin-synthetic" },
      "culture",
      body,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    mocks.repository.putCategory.mockResolvedValueOnce({ status: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" });
    const conflict = await putCategory(new Request(`${SITE}/internal/guide-admin/v1/categories/culture`, {
      method: "PUT", headers: mutationHeaders, body: JSON.stringify(body),
    }), categoryContext);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict", reason: "idempotency_key_reused" });
  });
});
