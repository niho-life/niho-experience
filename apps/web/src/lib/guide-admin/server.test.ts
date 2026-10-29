import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ repositoryFactory: vi.fn(), verifyIdToken: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));
vi.mock("@/lib/config", () => ({
  config: {
    guideAdminApiEnabled: false,
    guideAdminAudience: "",
    guideAdminServiceAccountEmail: "",
  },
}));
vi.mock("@/lib/experience/store-server", () => ({ guideAdminRepository: mocks.repositoryFactory }));

import {
  exactObject,
  guideAdminCommandHeaders,
  loadGuideAdmin,
  readGuideAdminMutation,
  verifyGuideAdminServiceIdentity,
  googleGuideAdminTokenVerifier,
  type GuideAdminTokenVerifier,
} from "./server";

const settings = {
  audience: "https://experience.example/internal/guide-admin",
  serviceAccountEmail: "guide-admin@example.iam.gserviceaccount.com",
};
const validClaims = {
  iss: "https://accounts.google.com",
  aud: settings.audience,
  email: settings.serviceAccountEmail,
  emailVerified: true,
  exp: Math.floor(Date.now() / 1000) + 300,
};
const request = (authorization = "Bearer synthetic.jwt.token") => new Request("https://experience.example/internal/guide-admin/v1/categories", {
  headers: { authorization },
});
const verifier = (result: Awaited<ReturnType<GuideAdminTokenVerifier["verify"]>>): GuideAdminTokenVerifier => ({
  verify: vi.fn().mockResolvedValue(result),
});

beforeEach(() => vi.clearAllMocks());

describe("guide admin service identity", () => {
  it("accepts only the configured Google service identity and never cookies or session roles", async () => {
    const validVerifier = verifier({ ok: true, claims: validClaims });
    expect((await verifyGuideAdminServiceIdentity(request(), settings, validVerifier)).ok).toBe(true);
    expect(validVerifier.verify).toHaveBeenCalledWith("synthetic.jwt.token", settings.audience);

    for (const authorization of ["", "Basic token", "Bearer", "Bearer token extra"]) {
      const unused = verifier({ ok: true, claims: validClaims });
      const candidate = new Request("https://experience.example/internal/guide-admin/v1/categories", {
        headers: {
          ...(authorization ? { authorization } : {}),
          cookie: "admin-session=synthetic; editor-session=synthetic; host-session=synthetic",
          "x-niho-admin-role": "ADMIN",
        },
      });
      const result = await verifyGuideAdminServiceIdentity(candidate, settings, unused);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
      expect(unused.verify).not.toHaveBeenCalled();
    }
  });

  it("rejects Firebase issuer, wrong audience/email, unverified email, and expiry", async () => {
    const invalidClaims = [
      { ...validClaims, iss: "https://securetoken.google.com/project" },
      { ...validClaims, aud: "https://wrong.example" },
      { ...validClaims, email: "other@example.iam.gserviceaccount.com" },
      { ...validClaims, emailVerified: false },
      { ...validClaims, exp: Math.floor(Date.now() / 1000) - 1 },
    ];
    for (const claims of invalidClaims) {
      const result = await verifyGuideAdminServiceIdentity(request(), settings, verifier({ ok: true, claims }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
        expect(result.response.headers.get("cache-control")).toBe("private, no-store");
        expect(result.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
    }
  });

  it("separates invalid credentials from identity verification outages", async () => {
    const invalid = await verifyGuideAdminServiceIdentity(request(), settings, verifier({ ok: false, kind: "invalid" }));
    const outage = await verifyGuideAdminServiceIdentity(request(), settings, verifier({ ok: false, kind: "outage" }));
    expect(invalid.ok).toBe(false);
    expect(outage.ok).toBe(false);
    if (!invalid.ok && !outage.ok) {
      expect(invalid.response.status).toBe(401);
      expect(outage.response.status).toBe(503);
    }
  });

  it("classifies malformed-token TypeErrors as invalid and network failures as unavailable", async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new TypeError("Malformed token payload"));
    expect(await googleGuideAdminTokenVerifier.verify("malformed", settings.audience)).toEqual({ ok: false, kind: "invalid" });
    mocks.verifyIdToken.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } }));
    expect(await googleGuideAdminTokenVerifier.verify("valid-but-key-fetch-failed", settings.audience)).toEqual({ ok: false, kind: "outage" });
  });
});

describe("guide admin HTTP boundary", () => {
  it("returns 404 before identity verification or database access when disabled", async () => {
    const unusedVerifier = verifier({ ok: true, claims: validClaims });
    const result = await loadGuideAdmin(request(), {
      settings: { enabled: false, audience: "", serviceAccountEmail: "" },
      verifier: unusedVerifier,
      repository: mocks.repositoryFactory,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
    expect(unusedVerifier.verify).not.toHaveBeenCalled();
    expect(mocks.repositoryFactory).not.toHaveBeenCalled();
  });

  it("verifies identity before loading the database and reports a missing store as unavailable", async () => {
    mocks.repositoryFactory.mockReturnValue(null);
    const result = await loadGuideAdmin(request(), {
      settings: { enabled: true, ...settings },
      verifier: verifier({ ok: true, claims: validClaims }),
      repository: mocks.repositoryFactory,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(mocks.repositoryFactory).toHaveBeenCalledOnce();

    mocks.repositoryFactory.mockClear();
    const unauthorized = await loadGuideAdmin(request(), {
      settings: { enabled: true, ...settings },
      verifier: verifier({ ok: false, kind: "invalid" }),
      repository: mocks.repositoryFactory,
    });
    expect(unauthorized.ok).toBe(false);
    expect(mocks.repositoryFactory).not.toHaveBeenCalled();
  });

  it("accepts only bounded strict JSON, exact fields, UUIDv4 keys, and stable actor IDs", async () => {
    const valid = new Request("https://experience.example/internal/guide-admin/v1/categories/culture", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "00000000-0000-4000-8000-000000000001",
        "x-niho-admin-actor-id": "admin-synthetic",
      },
      body: JSON.stringify({ active: true }),
    });
    expect(exactObject(await readGuideAdminMutation(valid), ["active"])).toEqual({ active: true });
    expect(guideAdminCommandHeaders(valid)).toEqual({
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      actorNihoUserId: "admin-synthetic",
    });

    const query = new Request("https://experience.example/internal/guide-admin/v1/categories/culture?force=true", {
      method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
    });
    await expect(readGuideAdminMutation(query)).rejects.toThrow();
    const oversized = new Request("https://experience.example/internal/guide-admin/v1/categories/culture", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(17 * 1024) }),
    });
    await expect(readGuideAdminMutation(oversized)).rejects.toThrow();
    expect(() => exactObject({ active: true, extra: true }, ["active"])).toThrow();
    expect(() => guideAdminCommandHeaders(new Request(valid.url, {
      headers: { "idempotency-key": "not-v4", "x-niho-admin-actor-id": "admin-synthetic" },
    }))).toThrow();
  });
});
