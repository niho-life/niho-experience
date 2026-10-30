import { describe, expect, it } from "vitest";
import type { ExperienceProviderPageListing } from "@niho-experience/api-client/host";
import { LISTING_TEXT, listingRefusal, liveListingStatus, liveListingView, providerReviewLine, PUBLISH_BLOCKER_TEXT, publishBlockerText, readListingResponse } from "./live-listing-state";

const SITE = "https://experience.example.test";
const listing = (status: ExperienceProviderPageListing["status"], slug: string | null = null): ExperienceProviderPageListing => ({
  id: "listing_1", spotId: "spot_1", campaignPageId: "page_1", status, slug, regionKey: null, consentVersion: "sample-listing-consent-1",
  consentedAt: "2026-10-27T01:00:00.000Z", approvedAt: null, pausedAt: null, withdrawnAt: null, createdAt: "2026-10-27T01:00:00.000Z", updatedAt: "2026-10-27T01:00:00.000Z",
});
const page = (patch: Partial<{ status: "DRAFT" | "PUBLISHED" | "UNPUBLISHED"; language: "EN" | "JA"; publishBlockers: string[] }> = {}) => ({ status: "PUBLISHED" as const, language: "EN" as const, publishBlockers: [], ...patch }) as Parameters<typeof liveListingView>[1];

describe("live listing state", () => {
  it("shows one pill: none and withdrawn read 未申請", () => {
    expect([null, listing("WITHDRAWN"), listing("REQUESTED"), listing("ACTIVE"), listing("PAUSED")].map((item) => liveListingStatus(item))).toEqual([
      { label: "未申請", tone: "draft" }, { label: "未申請", tone: "draft" }, { label: "審査待ち", tone: "wait" }, { label: "掲載中", tone: "ok" }, { label: "停止中", tone: "stop" },
    ]);
  });

  it("offers 申請 only for an English page ready to publish", () => {
    expect(liveListingView(null, page({ status: "DRAFT" }), SITE)).toEqual({ kind: "request", block: null, withdrawable: false });
    expect(liveListingView(null, page({ language: "JA" }), SITE)).toEqual({ kind: "request", block: "language", withdrawable: false });
    expect(liveListingView(listing("WITHDRAWN"), page({ status: "DRAFT", publishBlockers: ["OFFER_ACTIVE_REQUIRED"] }), SITE)).toEqual({ kind: "request", block: "blockers", withdrawable: false });
  });

  it("follows NIHO's listing, and asks for 申請 again once the page is no longer published", () => {
    expect(liveListingView(listing("REQUESTED"), page(), SITE)).toEqual({ kind: "requested" });
    expect(liveListingView(listing("PAUSED"), page(), SITE)).toEqual({ kind: "paused" });
    expect(liveListingView(listing("PAUSED"), page({ status: "UNPUBLISHED" }), SITE)).toEqual({ kind: "request", block: null, withdrawable: true });
    expect(liveListingView(listing("ACTIVE", "synthetic tea"), page({ status: "UNPUBLISHED" }), SITE)).toEqual({ kind: "active", href: `${SITE}/experiences/synthetic%20tea` });
    expect(liveListingView(listing("ACTIVE"), page(), SITE)).toEqual({ kind: "active", href: null });
  });

  it("names the provider review only until it is approved", () => {
    expect(providerReviewLine("APPROVED")).toBeNull();
    expect(providerReviewLine(null)).toBeNull();
    expect(providerReviewLine("DRAFT")).toEqual({ text: "提供者の審査をまだ申請していません。", link: "設定で審査を申請" });
    expect(providerReviewLine("REQUESTED")).toEqual({ text: "提供者の審査を NIHO が確認しています。", link: null });
    expect(providerReviewLine("SUSPENDED")?.link).not.toBeNull();
  });

  it("never resends an unanswered call and reads the listing again after NIHO's refusals", () => {
    expect(listingRefusal("request", 0, null)).toEqual({ kind: "uncertain", tone: "error", text: LISTING_TEXT.requestUncertain });
    expect(listingRefusal("request", 502, "upstream_unavailable")).toMatchObject({ kind: "uncertain" });
    expect(listingRefusal("withdraw", 503, null)).toEqual({ kind: "uncertain", tone: "error", text: LISTING_TEXT.withdrawUncertain });
    expect(listingRefusal("request", 422, "EXPERIENCE_LISTING_CONSENT_OUTDATED")).toEqual({ kind: "reload", tone: "notice", text: LISTING_TEXT.consentOutdated });
    expect(listingRefusal("request", 422, "EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE")).toMatchObject({ kind: "reload", text: LISTING_TEXT.notEligible });
    expect(listingRefusal("request", 409, "EXPERIENCE_LISTING_STATUS_CONFLICT")).toEqual({ kind: "reload", tone: "error", text: LISTING_TEXT.changed });
    expect(listingRefusal("request", 409, "PAGE_UPDATED")).toMatchObject({ kind: "reload" });
    expect(listingRefusal("request", 422, "PAGE_PUBLISH_BLOCKED")).toMatchObject({ kind: "error", text: "公開前に確認が必要な項目があります。" });
    expect(listingRefusal("withdraw", 404, "permission_ended")).toMatchObject({ kind: "error", text: "この体験を操作する権限が終了しています。" });
  });

  it("reads only the listing BFF's shape", () => {
    const consent = { version: "sample-listing-consent-1", text: "（合成）同意の文言" };
    expect(readListingResponse({ listing: null, consent })).toEqual({ listing: null, consent });
    expect(readListingResponse({ listing: listing("ACTIVE"), consent })).not.toBeNull();
    for (const value of [null, { listing: null }, { listing: null, consent: { version: "", text: "x" } }, { listing: { status: "LIVE" }, consent }]) expect(readListingResponse(value)).toBeNull();
  });
});

describe("publishBlockerText", () => {
  it("says what to fix in Japanese, never NIHO's code", () => {
    expect(publishBlockerText("COVER_REQUIRED")).toBe("表紙の写真を追加してください。");
    expect(publishBlockerText("NEW_UNKNOWN_BLOCKER")).toBe("NIHO で確認が必要な項目があります。");
    for (const text of Object.values(PUBLISH_BLOCKER_TEXT)) expect(text).not.toMatch(/[A-Z]+_[A-Z_]+/);
  });
});
