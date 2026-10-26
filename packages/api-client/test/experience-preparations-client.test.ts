import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createExperiencePreparationAdminApiClient, createExperiencePreparationHostApiClient, createExperiencePreparationReviewApiClient } from "../src/experience-preparations/client.ts";
import { decodeExperiencePreparationDraft, decodeExperiencePreparationEditorPatch, isExperiencePreparationSchema } from "../src/experience-preparations/schema.ts";

const content = { lead: "合成の紹介", facts: { language: "日本語・英語" }, highlights: ["合成の見どころ"], timeline: [], description: "合成データです", included: [], notIncluded: [], notSuitableFor: [], meetingPoint: { entranceNote: "合成の入口", exteriorPhotoObjectKey: null }, knowBeforeYouGo: [], hostUserIds: [] };
const proposal = {
  target: { mode: "NEW_PROVIDER" as const, providerId: null }, provider: { kind: "BUSINESS" as const, displayName: "合成商店", bio: "合成", sellerDisclosureUrl: null }, pageSlugBase: "synthetic-experience",
  pages: { ja: { title: "合成体験", content }, en: { title: "Synthetic experience", content } }, photos: [],
  offer: { nameJa: "合成商品", nameEn: "Synthetic offer", shortDescriptionJa: null, shortDescriptionEn: null, priceYen: 3000, childPriceYen: null, childMinAge: null, childMaxAge: null, adultRequiredForChild: true, capacity: 4, maxPartySize: 4, minimumParticipants: 1, weekdays: [6], startTime: "10:00", durationMinutes: 60, cutoffDays: 2, closedDates: [], cancellationPolicy: "MODERATE" as const, acceptanceMode: "REQUEST" as const },
  operatingRoles: [{ party: "PROVIDER" as const, responsibilities: ["実施"] }],
};
const draft = { ...proposal, provider: { ...proposal.provider, contactName: "合成担当", contactEmail: "synthetic@example.test" }, supportScopes: ["DRAFT_EDITING" as const] };
const review = { caseId: "case_1", status: "REVIEW", revision: 1, snapshotHash: "a".repeat(64), proposal, consents: { preparation: { version: "v1", text: { content: "内容", salesTerms: "条件", support: "支援", representative: "代表" } }, provider: { required: true, version: "pv1", text: "提供者規約" }, listing: { version: "lv1", text: "掲載同意" } }, images: [], expiresAt: "2026-11-01T00:00:00.000Z" };
const token = "t".repeat(43);

describe("experience preparation selected validation", () => {
  it("accepts the backend proposal schema and rejects unknown or incomplete draft fields", () => {
    expect(decodeExperiencePreparationDraft(draft)).toEqual(draft);
    expect(decodeExperiencePreparationDraft({ ...draft, internalUser: { email: "private@example.test" } })).toBeNull();
    expect(isExperiencePreparationSchema("ReviewResponse", review)).toBe(true);
  });

  it("limits DRAFT_EDITOR patches to pages and photos", () => {
    expect(decodeExperiencePreparationEditorPatch({ expectedRevision: 1, draft: { pages: proposal.pages, photos: [] } })).not.toBeNull();
    expect(decodeExperiencePreparationEditorPatch({ expectedRevision: 1, draft: { pages: proposal.pages, offer: proposal.offer } })).toBeNull();
    expect(decodeExperiencePreparationEditorPatch({ expectedRevision: 1, draft: { provider: { contactEmail: "private@example.test" } } })).toBeNull();
  });
});

describe("experience preparation transports", () => {
  it("sends anonymous review tokens only in a POST body", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(review));
    const result = await createExperiencePreparationReviewApiClient({ nihoWebOrigin: "https://niho.example", fetch: fetcher }).review(token);
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/experience-preparations/review");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "manual" });
    expect(JSON.parse(String(init.body))).toEqual({ token });
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(token);
  });

  it("uses dedicated bearer calls and fixed encoded paths", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ cases: [] }));
    const result = await createExperiencePreparationAdminApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: fetcher }).listCases();
    expect(result).toEqual({ ok: true, data: { cases: [] } });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://niho.example/api/experience-preparations/admin/cases");
    expect(new Headers((fetcher.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe("Bearer admin-token");

    const host = createExperiencePreparationHostApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: fetcher });
    expect(await host.getCase("../admin")).toEqual({ ok: false, kind: "invalid_request" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed success, auth, conflicts and transport uncertainty without mock fallback", async () => {
    const resultFor = (response: Response) => createExperiencePreparationReviewApiClient({ nihoWebOrigin: "https://niho.example", fetch: vi.fn(async () => response) }).review(token);
    expect(await resultFor(Response.json({ ...review, privateEmail: "leak@example.test" }))).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await resultFor(Response.json({}, { status: 404 }))).toEqual({ ok: false, kind: "not_found" });
    const admin = createExperiencePreparationAdminApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: vi.fn(async () => Response.json({ error: { code: "CONFLICT", message: "private", details: { reason: "PREPARATION_REVISION_CONFLICT" } } }, { status: 409 })) });
    expect(await admin.patchCase("case_1", 1, draft)).toEqual({ ok: false, kind: "conflict", reason: "PREPARATION_REVISION_CONFLICT" });
    const privateReason = createExperiencePreparationAdminApiClient({ nihoWebOrigin: "https://niho.example", idToken: "admin-token", fetch: vi.fn(async () => Response.json({ error: { code: "CONFLICT", message: "private", details: { reason: "PRIVATE_DATABASE_REASON" } } }, { status: 409 })) });
    expect(await privateReason.patchCase("case_1", 1, draft)).toEqual({ ok: false, kind: "conflict", reason: null });
    const down = createExperiencePreparationReviewApiClient({ nihoWebOrigin: "https://niho.example", fetch: vi.fn(async () => { throw new Error("timeout"); }) });
    expect(await down.review(token)).toEqual({ ok: false, kind: "network_error" });
  });
});
