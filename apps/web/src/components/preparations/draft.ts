import type { ExperiencePreparationAdminCase, ExperiencePreparationDraft } from "@niho-experience/api-client/experience-preparations";

const content = () => ({ lead: "", facts: { language: "日本語・英語" }, highlights: [], timeline: [], description: "", included: [], notIncluded: [], notSuitableFor: [], meetingPoint: { entranceNote: "", exteriorPhotoObjectKey: null }, knowBeforeYouGo: [], hostUserIds: [] });

export function emptyPreparationDraft(): ExperiencePreparationDraft {
  return {
    target: { mode: "NEW_PROVIDER", providerId: null },
    provider: { kind: "BUSINESS", displayName: "", bio: "", sellerDisclosureUrl: null, contactName: "", contactEmail: "" },
    pageSlugBase: "new-experience",
    pages: { ja: { title: "", content: content() }, en: { title: "", content: content() } },
    photos: [],
    offer: { nameJa: "", nameEn: "", shortDescriptionJa: null, shortDescriptionEn: null, priceYen: 0, childPriceYen: null, childMinAge: null, childMaxAge: null, adultRequiredForChild: true, capacity: 1, maxPartySize: 1, minimumParticipants: 1, weekdays: [], startTime: "10:00", durationMinutes: 60, cutoffDays: 2, closedDates: [], cancellationPolicy: "MODERATE", acceptanceMode: "REQUEST" },
    operatingRoles: [{ party: "PROVIDER", responsibilities: ["体験の実施と旅行者対応"] }, { party: "NIHO", responsibilities: ["掲載準備の支援"] }],
    supportScopes: ["DRAFT_EDITING", "TRANSLATION", "ONBOARDING_GUIDANCE"],
  };
}

export function preparationDraftFromAdminCase(value: ExperiencePreparationAdminCase): ExperiencePreparationDraft | null {
  if (!value.proposal || !value.contact) return null;
  return {
    target: value.proposal.target,
    provider: { ...value.proposal.provider, contactName: value.contact.name, contactEmail: value.contact.email },
    pageSlugBase: value.pageSlugBase,
    pages: value.proposal.pages,
    photos: value.proposal.photos,
    offer: value.proposal.offer,
    operatingRoles: value.proposal.operatingRoles,
    supportScopes: value.supportScopes.filter((item): item is ExperiencePreparationDraft["supportScopes"][number] => ["DRAFT_EDITING", "TRANSLATION", "SCHEDULING", "ONBOARDING_GUIDANCE"].includes(item)),
  };
}

/** Textareas keep unfinished lines while editing; the API receives only finished items. */
export function normalizePreparationDraft(draft: ExperiencePreparationDraft): ExperiencePreparationDraft {
  const lines = (values: readonly string[]) => values.map((value) => value.trim()).filter(Boolean);
  return {
    ...draft,
    pages: {
      ja: { ...draft.pages.ja, content: { ...draft.pages.ja.content, highlights: lines(draft.pages.ja.content.highlights), included: lines(draft.pages.ja.content.included), notIncluded: lines(draft.pages.ja.content.notIncluded), notSuitableFor: lines(draft.pages.ja.content.notSuitableFor), knowBeforeYouGo: lines(draft.pages.ja.content.knowBeforeYouGo) } },
      en: { ...draft.pages.en, content: { ...draft.pages.en.content, highlights: lines(draft.pages.en.content.highlights), included: lines(draft.pages.en.content.included), notIncluded: lines(draft.pages.en.content.notIncluded), notSuitableFor: lines(draft.pages.en.content.notSuitableFor), knowBeforeYouGo: lines(draft.pages.en.content.knowBeforeYouGo) } },
    },
    offer: { ...draft.offer, closedDates: lines(draft.offer.closedDates) },
    operatingRoles: draft.operatingRoles.map((role) => ({ ...role, responsibilities: lines(role.responsibilities) })),
  };
}
