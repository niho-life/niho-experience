import { describe, expect, it } from "vitest";
import { buildFixtureExperiences, journeyExtrasFor, reviewsResponseFor, toExperienceSummary } from "@niho-experience/api-client/mock";
import type { JourneyReviews } from "@niho-experience/api-client";
import { buildCardModel } from "./card-model";
import { averageLabel, cardReviewLine, countLabel, monthYear, ratingLabel, reviewDisplay, reviewHeadline, summaryDisplay, withReviewLines } from "./reviews-ui";
import { experienceJsonLd, reviewsForJsonLd, serializeJsonLd } from "./structured-data";

const ok = (slug: string): JourneyReviews => journeyExtrasFor(slug).reviews!;
const INDIGO = "indigo-dyeing-with-an-artisan"; // 12 reviews
const POTTERY = "evening-pottery-session"; // 2 reviews
const CYCLING = "seaside-cycling-and-market-breakfast"; // 1 review
const DINNER = "home-cooked-dinner-with-locals"; // none

describe("what is shown for each number of reviews", () => {
  it("shows the average from three reviews, only the count under that, and New for none", () => {
    expect(reviewDisplay(ok(INDIGO))).toEqual({ kind: "rated", count: 12, average: 4.9 });
    expect(reviewDisplay(ok(POTTERY))).toEqual({ kind: "few", count: 2 });
    expect(reviewDisplay(ok(CYCLING))).toEqual({ kind: "few", count: 1 });
    expect(reviewDisplay(ok(DINNER))).toEqual({ kind: "none" });
    const edge = (count: number) => summaryDisplay({ count, average: count ? 4.5 : null, tags: [] }).kind;
    expect([edge(0), edge(1), edge(2), edge(3), edge(4)]).toEqual(["none", "few", "few", "rated", "rated"]);
  });

  it("tells a failed read and a deployment without reviews apart from no reviews", () => {
    expect(reviewDisplay({ status: "unavailable" })).toEqual({ kind: "unavailable" });
    expect(reviewDisplay(null)).toEqual({ kind: "off" });
    expect(reviewHeadline({ kind: "unavailable" })).toBeNull();
    expect(reviewHeadline({ kind: "off" })).toBeNull();
  });

  it("does not show an average that the data does not carry", () => {
    expect(summaryDisplay({ count: 5, average: null, tags: [] })).toEqual({ kind: "few", count: 5 });
  });
});

describe("the line under the title and the card line", () => {
  it("links to the reviews with the rating, a plain count, or shows New", () => {
    expect(reviewHeadline(reviewDisplay(ok(INDIGO)))).toEqual({ label: "★ 4.9 · 12 reviews", accessibleLabel: "Rated 4.9 out of 5 from 12 reviews. Go to the reviews", href: "#reviews" });
    expect(reviewHeadline(reviewDisplay(ok(POTTERY)))).toEqual({ label: "2 reviews", accessibleLabel: "2 reviews. Go to the reviews", href: "#reviews" });
    expect(reviewHeadline(reviewDisplay(ok(CYCLING)))).toMatchObject({ label: "1 review" });
    expect(reviewHeadline(reviewDisplay(ok(DINNER)))).toEqual({ label: "New", isNew: true });
  });

  it("puts a line on cards that have reviews and none on the rest", () => {
    expect(cardReviewLine(reviewsResponseFor(INDIGO, 1).summary)).toEqual({ text: "★ 4.9 · 12", label: "Rated 4.9 out of 5 from 12 reviews" });
    expect(cardReviewLine(reviewsResponseFor(POTTERY, 1).summary)).toEqual({ text: "2 reviews", label: "2 reviews" });
    expect(cardReviewLine(reviewsResponseFor(DINNER, 1).summary)).toBeNull();
    expect(cardReviewLine(null)).toBeNull();
    expect(cardReviewLine(undefined)).toBeNull();
  });

  it("adds the line to the matching cards only", () => {
    const experiences = buildFixtureExperiences();
    const cards = experiences.map((experience) => buildCardModel(toExperienceSummary(experience), experience));
    const summaries = new Map([[INDIGO, reviewsResponseFor(INDIGO, 1).summary]]);
    const withLines = withReviewLines(cards, summaries);
    expect(withLines.find((card) => card.slug === INDIGO)?.reviewLine).toEqual({ text: "★ 4.9 · 12", label: "Rated 4.9 out of 5 from 12 reviews" });
    expect(withLines.filter((card) => card.reviewLine)).toHaveLength(1);
    expect(withReviewLines(cards, new Map())).toEqual(cards);
  });

  it("formats counts, averages, ratings and the month in Japan time", () => {
    expect(countLabel(1)).toBe("1 review");
    expect(countLabel(12)).toBe("12 reviews");
    expect(averageLabel(4.92)).toBe("4.9");
    expect(averageLabel(5)).toBe("5.0");
    expect(ratingLabel(5)).toBe("Rated 5 out of 5");
    expect(ratingLabel(4.92)).toBe("Rated 4.9 out of 5");
    expect(monthYear("2026-10-14T03:00:00.000Z")).toBe("October 2026");
    // 31 Oct 16:00 UTC is already 1 Nov in Japan.
    expect(monthYear("2026-10-31T16:00:00.000Z")).toBe("November 2026");
    expect(monthYear("not a date")).toBe("");
  });
});

describe("structured data says only what the page shows", () => {
  const SITE = "https://experience.example.com";
  const experience = { ...buildFixtureExperiences({ imageBaseUrl: "https://images.example.com" }).find((item) => item.slug === INDIGO)!, canonicalUrl: `${SITE}/experiences/${INDIGO}` };

  it("marks up the rating and the shown reviews from three reviews", () => {
    const reviews = reviewsForJsonLd(ok(INDIGO));
    expect(reviews).toMatchObject({ count: 12, average: 4.9 });
    expect(reviews?.items).toHaveLength(3);
    const data = experienceJsonLd(experience, SITE, false, true, reviews)!;
    expect(data.aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: 4.9, reviewCount: 12, bestRating: 5, worstRating: 1 });
    const review = (data.review as Record<string, unknown>[])[0]!;
    expect(review).toMatchObject({ "@type": "Review", reviewRating: { "@type": "Rating", ratingValue: 5, bestRating: 5, worstRating: 1 }, author: { "@type": "Person", name: "Emma (sample)" }, datePublished: "2026-10-14" });
    expect(String(review.reviewBody)).toContain("The quiet of the studio");
    // Nothing the page does not show: no host reply, no tags, no booking identifiers.
    expect(JSON.stringify(data)).not.toMatch(/Reply from|Thank you for dyeing|rv-indigo|tags/);
  });

  it("marks up nothing for one or two reviews, none, a failed read, a preview or a deployment without reviews", () => {
    for (const reviews of [ok(POTTERY), ok(CYCLING), ok(DINNER), { status: "unavailable" } as JourneyReviews, null]) {
      expect(reviewsForJsonLd(reviews)).toBeNull();
      const data = experienceJsonLd(experience, SITE, false, true, reviewsForJsonLd(reviews))!;
      expect(data.aggregateRating).toBeUndefined();
      expect(data.review).toBeUndefined();
    }
    expect(experienceJsonLd(experience, SITE, true, true, reviewsForJsonLd(ok(INDIGO)))).toBeNull();
  });

  it("still escapes script-breaking characters in a review", () => {
    const hostile = { ...ok(INDIGO), items: [{ ...(ok(INDIGO) as Extract<JourneyReviews, { status: "ok" }>).items[0]!, body: "</script><script>alert(1)</script>" }] } as JourneyReviews;
    const data = experienceJsonLd(experience, SITE, false, true, reviewsForJsonLd(hostile))!;
    expect(serializeJsonLd(data)).not.toContain("</script>");
  });
});
