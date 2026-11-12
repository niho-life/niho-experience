import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { createExperienceApiClient } from "@niho-experience/api-client";
import { buildFixtureExperiences, createMockExperienceFetch } from "@niho-experience/api-client/mock";
import { siteSaleTerms, withSiteSaleTerms } from "@/lib/guest-booking-terms";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

/** An experience sold here (#285): after QUESTIONS_CHANGED / PRICE_CHANGED / CONSENT_OUTDATED the form reads the sale from this site. */
const state = vi.hoisted(() => ({
  refresh: undefined as undefined | (() => Promise<void>),
  locale: "en" as "en" | "ja",
  model: null as null | Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/SiteLocale", async () => {
  const { EN_STATIC_COPY_V1 } = await import("@niho/experience-presentation/v1");
  return { useSiteLocale: () => ({ locale: state.locale, releaseId: null }), useSiteCopy: () => EN_STATIC_COPY_V1 };
});
vi.mock("@niho/experience-presentation/v1", async (original) => ({
  ...await original<typeof import("@niho/experience-presentation/v1")>(),
  BookingCheckoutViewV1: ({ model, callbacks }: { model: Record<string, unknown>; callbacks: { onRefresh: () => Promise<void> } }) => { state.model = model; state.refresh = callbacks.onRefresh; return null; },
}));

import { BookingForm } from "./BookingForm";

afterEach(() => { vi.unstubAllGlobals(); state.locale = "en"; state.model = null; });

it("reads the sale terms again from this site, not NIHO's detail, and keeps NIHO's content", async () => {
  const sale = siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-11");
  const fetchMock = vi.fn(async () => Response.json(sale));
  vi.stubGlobal("fetch", fetchMock);
  const api = createExperienceApiClient({ nihoWebOrigin: "https://experience.example", thisSite: true, fetch: createMockExperienceFetch() });
  const readNiho = [vi.spyOn(api, "getExperience"), vi.spyOn(api, "getExperienceV11"), vi.spyOn(api, "getExperienceV14")];
  const experience = withSiteSaleTerms(buildFixtureExperiences()[0]!, siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-10"));
  const offer = experience.offers[0]!;
  const refreshExperience = vi.fn(() => true);
  renderToStaticMarkup(createElement(BookingForm, {
    api, apiUnavailable: false, experience, offer, selection: { offerId: offer.id, date: "2026-11-02", adultCount: 1, childCount: 0 },
    preview: false, attributionEnabled: false, publicApiVersion: "1.2", onExperienceRefresh: refreshExperience,
    bookingSource: { kind: "site", origin: "https://experience.example" },
    draft: { guestName: "", guestEmail: "", note: "", answerSets: {} }, onDraftChange: vi.fn(), attemptRef: { current: null }, onBack: vi.fn(),
  }));
  await state.refresh!();
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`https://experience.example/api/public/experiences/${experience.slug}/booking-terms`);
  for (const read of readNiho) expect(read).not.toHaveBeenCalled();
  expect(refreshExperience).toHaveBeenCalledOnce();
  const [latest, conditions] = refreshExperience.mock.calls[0] as unknown as [typeof experience, unknown];
  expect(latest).toEqual(withSiteSaleTerms(experience, sale));
  expect(latest.booking.consentVersion).toBe("sample-terms-2026-11");
  expect(latest.description).toBe(experience.description);
  expect(conditions).toBeUndefined();
});

it("renders Japanese minimum-charge and explicit custom cancellation terms with localized image alt", () => {
  state.locale = "ja";
  const base = buildFixtureExperiences()[0]!;
  const localizedAlt = "合成カバー写真";
  const experience = {
    ...base,
    cover: base.cover ? { ...base.cover, alt: localizedAlt } : null,
    offers: base.offers.map((item, index) => index === 0 ? {
      ...item,
      minimumChargeableParticipants: 3,
      cancellationPolicy: { code: "NONE" as const, freeCancellationHoursBefore: null },
      saleCancellation: { policyCode: "CUSTOM" as const, cancellationWindowMinutesBeforeStart: 90, refundBasisPoints: 3_750 },
    } : item),
  } as unknown as typeof base & { offers: Array<typeof base.offers[number] & { minimumChargeableParticipants: number; saleCancellation: { policyCode: "CUSTOM"; cancellationWindowMinutesBeforeStart: number; refundBasisPoints: number } }> };
  const offer = experience.offers[0]!;
  renderToStaticMarkup(createElement(BookingForm, {
    api: null, apiUnavailable: true, experience, offer, selection: { offerId: offer.id, date: "2026-11-02", adultCount: 1, childCount: 0 },
    preview: false, attributionEnabled: false, publicApiVersion: "1.2", onExperienceRefresh: vi.fn(() => true),
    bookingSource: { kind: "site", origin: "https://experience.example" },
    draft: { guestName: "", guestEmail: "", note: "", answerSets: {} }, onDraftChange: vi.fn(), attemptRef: { current: null }, onBack: vi.fn(),
  }));
  expect(state.model).toMatchObject({
    total: "￥19,500",
    policyTitle: "90分前までの取消で37.5％返金",
    consentVersion: experience.booking.consentVersion,
  });
  expect(state.model?.summary).toMatchObject({ image: { alt: localizedAlt } });
});

it("describes MANAGED_20 approval as a cardless request without changing the legacy approval copy", () => {
  const base = buildFixtureExperiences()[0]!;
  const experience = {
    ...base,
    offers: base.offers.map((item, index) => index === 0 ? { ...item, acceptanceMode: "APPROVAL" as const } : item),
  };
  const offer = experience.offers[0]!;
  const props = {
    api: null, apiUnavailable: true, experience, offer,
    selection: { offerId: offer.id, date: "2026-11-02", adultCount: 1, childCount: 0 },
    preview: false, attributionEnabled: false, publicApiVersion: "1.2" as const, onExperienceRefresh: vi.fn(() => true),
    draft: { guestName: "", guestEmail: "", note: "", answerSets: {} }, onDraftChange: vi.fn(), attemptRef: { current: null }, onBack: vi.fn(),
  };
  renderToStaticMarkup(createElement(BookingForm, { ...props, bookingSource: { kind: "site", origin: "https://experience.example" } as const }));
  expect(state.model).toMatchObject({
    approval: true,
    confirmationNote: "No card is needed now. If the office approves your request, they will send you a time-limited Stripe payment link.",
    paymentDisclosure: "No card details are collected and no charge is made when you send this request.",
  });

  renderToStaticMarkup(createElement(BookingForm, props));
  expect(state.model).not.toHaveProperty("confirmationNote");
  expect(state.model).not.toHaveProperty("paymentDisclosure");
});
