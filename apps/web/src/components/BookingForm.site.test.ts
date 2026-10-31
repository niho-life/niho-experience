import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { createExperienceApiClient } from "@niho-experience/api-client";
import { buildFixtureExperiences, createMockExperienceFetch } from "@niho-experience/api-client/mock";
import { siteSaleTerms, withSiteSaleTerms } from "@/lib/guest-booking-terms";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

/** An experience sold here (#285): after QUESTIONS_CHANGED / PRICE_CHANGED / CONSENT_OUTDATED the form reads the sale from this site. */
const state = vi.hoisted(() => ({ refresh: undefined as undefined | (() => Promise<void>) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/SiteLocale", async () => {
  const { EN_STATIC_COPY_V1 } = await import("@niho/experience-presentation/v1");
  return { useSiteLocale: () => ({ locale: "en", releaseId: null }), useSiteCopy: () => EN_STATIC_COPY_V1 };
});
vi.mock("@niho/experience-presentation/v1", async (original) => ({
  ...await original<typeof import("@niho/experience-presentation/v1")>(),
  BookingCheckoutViewV1: ({ callbacks }: { callbacks: { onRefresh: () => Promise<void> } }) => { state.refresh = callbacks.onRefresh; return null; },
}));

import { BookingForm } from "./BookingForm";

afterEach(() => vi.unstubAllGlobals());

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
