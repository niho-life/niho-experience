import { describe, expect, it } from "vitest";
import { inquiryContextFromSearch, inquiryHref } from "@/lib/group-inquiry-entry";

describe("inquiryContextFromSearch", () => {
  it("opens with no context and an individual/group inquiry when nothing is passed", () => {
    expect(inquiryContextFromSearch({})).toEqual({ kind: "PERSONAL", entry: "DIRECT", experienceSlug: null, experienceTitle: null, hostName: null });
  });

  it("takes the kind and the entry from a schools or companies page", () => {
    expect(inquiryContextFromSearch({ from: "school" })).toMatchObject({ kind: "SCHOOL", entry: "SCHOOL" });
    expect(inquiryContextFromSearch({ from: "corporate" })).toMatchObject({ kind: "CORPORATE", entry: "CORPORATE" });
    expect(inquiryContextFromSearch({ type: "listing", from: "listing" })).toMatchObject({ kind: "LISTING", entry: "LISTING" });
    // An explicit type wins over the entry's own.
    expect(inquiryContextFromSearch({ from: "school", type: "personal" })).toMatchObject({ kind: "PERSONAL", entry: "SCHOOL" });
  });

  it("carries an experience and its host from the experience page", () => {
    expect(inquiryContextFromSearch({ from: "experience", experience: "tea-at-a-temple", title: " Tea at a temple ", host: "Sato" })).toEqual({
      kind: "PERSONAL", entry: "EXPERIENCE", experienceSlug: "tea-at-a-temple", experienceTitle: "Tea at a temple", hostName: "Sato",
    });
    // A slug alone is enough to know the page; a person alone is a host's page.
    expect(inquiryContextFromSearch({ experience: "tea" })).toMatchObject({ entry: "EXPERIENCE", experienceTitle: null });
    expect(inquiryContextFromSearch({ host: "Sato" })).toMatchObject({ entry: "PROVIDER", hostName: "Sato", experienceSlug: null });
    expect(inquiryContextFromSearch({ from: "provider", host: "Sato" })).toMatchObject({ entry: "PROVIDER" });
  });

  it("ignores what does not fit instead of refusing the page", () => {
    expect(inquiryContextFromSearch({ type: "enterprise", from: "elsewhere", experience: "has space", title: "x", host: "a".repeat(101) })).toEqual({
      kind: "PERSONAL", entry: "DIRECT", experienceSlug: null, experienceTitle: null, hostName: null,
    });
    // A title with no slug is not attached.
    expect(inquiryContextFromSearch({ title: "Tea" }).experienceTitle).toBeNull();
    expect(inquiryContextFromSearch({ experience: ["a-slug", "b"] }).experienceSlug).toBe("a-slug");
  });
});

describe("inquiryHref", () => {
  it("builds the link a page uses, by language, with only public context", () => {
    expect(inquiryHref("en")).toBe("/inquiry");
    expect(inquiryHref("ja", { type: "SCHOOL", from: "SCHOOL" })).toBe("/ja/inquiry?type=school&from=school");
    const href = inquiryHref("ja", { from: "EXPERIENCE", experienceSlug: "tea", experienceTitle: "お茶の体験", hostName: "佐藤" });
    const params = new URL(href, "https://example.test").searchParams;
    expect(href.startsWith("/ja/inquiry?")).toBe(true);
    expect(Object.fromEntries(params)).toEqual({ from: "experience", experience: "tea", title: "お茶の体験", host: "佐藤" });
    // The link round-trips through the page's own reader.
    expect(inquiryContextFromSearch(Object.fromEntries(params))).toMatchObject({ entry: "EXPERIENCE", experienceSlug: "tea", experienceTitle: "お茶の体験", hostName: "佐藤" });
  });
});
