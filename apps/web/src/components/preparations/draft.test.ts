import { describe, expect, it } from "vitest";
import type { ExperiencePreparationAdminCase } from "@niho-experience/api-client/experience-preparations";
import { decodeExperiencePreparationCohostPatch, decodeExperiencePreparationDraft } from "@niho-experience/api-client/experience-preparations-schema";
import { emptyPreparationDraft, normalizePreparationDraft, preparationDraftFromAdminCase } from "./draft";

describe("assisted-launch structured forms", () => {
  const completedDraft = () => {
    const draft = emptyPreparationDraft();
    draft.provider.displayName = "合成店舗";
    draft.provider.contactName = "合成担当";
    draft.provider.contactEmail = "synthetic@example.test";
    draft.pages.ja.title = "合成体験";
    draft.pages.en.title = "Synthetic experience";
    draft.offer.nameJa = "合成商品";
    draft.offer.nameEn = "Synthetic offer";
    return draft;
  };

  it("starts from the complete backend draft shape, not a simplified DTO", () => {
    const draft = completedDraft();
    expect(decodeExperiencePreparationDraft(draft)).toEqual(draft);
    expect(draft.pages.ja.content).toMatchObject({ facts: { language: "日本語・英語" }, timeline: [], meetingPoint: { exteriorPhotoObjectKey: null } });
    expect(draft.offer).toMatchObject({ cancellationPolicy: "MODERATE", acceptanceMode: "REQUEST" });
  });

  it("keeps editable line breaks until submission and removes empty entries at the API boundary", () => {
    const draft = completedDraft();
    draft.pages.en.content.highlights = ["First ", "", " Second "];
    draft.offer.closedDates = ["2026-10-30", ""];
    const normalized = normalizePreparationDraft(draft);
    expect(normalized.pages.en.content.highlights).toEqual(["First", "Second"]);
    expect(normalized.offer.closedDates).toEqual(["2026-10-30"]);
    expect(draft.pages.en.content.highlights).toEqual(["First ", "", " Second "]);
  });

  it("keeps collaborator edits limited to pages and case photos", () => {
    const draft = completedDraft();
    expect(decodeExperiencePreparationCohostPatch({ expectedRevision: 1, draft: { pages: draft.pages, photos: draft.photos, offer: draft.offer } })).not.toBeNull();
    expect(decodeExperiencePreparationCohostPatch({ expectedRevision: 1, draft: { pages: draft.pages, contactEmail: "private@example.test" } })).toBeNull();
  });

  it("round-trips the Admin case slug, support scopes, target and private contact", () => {
    const source = completedDraft();
    source.pageSlugBase = "preserved-synthetic-slug";
    source.supportScopes = ["DRAFT_EDITING", "SCHEDULING"];
    source.target = { mode: "EXISTING_PROVIDER", providerId: "synthetic_provider" };
    const { contactName, contactEmail, ...provider } = source.provider;
    const adminCase = {
      id: "case_1", status: "REVIEW", revision: 2, snapshotHash: "a".repeat(64),
      proposal: { target: source.target, provider, pageSlugBase: source.pageSlugBase, pages: source.pages, photos: source.photos, offer: source.offer, operatingRoles: source.operatingRoles, cohosts: [] },
      contact: { name: contactName, email: contactEmail }, currentAcceptance: null, acceptanceHistory: [], representativeVerifiedAt: null, representativeVerifiedAcceptanceId: null, materialized: null, assignments: [], images: [],
      createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z", pageSlugBase: source.pageSlugBase, supportScopes: source.supportScopes,
    } satisfies ExperiencePreparationAdminCase;
    expect(preparationDraftFromAdminCase(adminCase)).toEqual(source);
  });
});
