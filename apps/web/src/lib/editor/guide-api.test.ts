import { describe, expect, it } from "vitest";
import { parseGuideCreateBody, parseGuidePatchBody } from "./guide-api";
import { parseGuidePublicationInput, parseGuideStopPublicationInput } from "./guide-publication";

describe("editor guide API input", () => {
  it("accepts only the exact create shape", () => {
    expect(parseGuideCreateBody({
      slug: "synthetic-walk",
      title: "Synthetic walk",
      subject: { kind: "PROVIDER", providerId: "provider-synthetic" },
      description: "A test-only guide.",
      categorySlug: "walks",
      content: {
        markdown: "## Synthetic",
        author: { name: "Synthetic Writer", role: "Guide", bio: "Test-only profile." },
        checkedOn: "2026-10-29",
      },
    })).toEqual({
      slug: "synthetic-walk",
      title: "Synthetic walk",
      subject: { kind: "PROVIDER", providerId: "provider-synthetic" },
      description: "A test-only guide.",
      categorySlug: "walks",
      content: {
        markdown: "## Synthetic",
        author: { name: "Synthetic Writer", role: "Guide", bio: "Test-only profile." },
        checkedOn: "2026-10-29",
      },
    });
    expect(parseGuideCreateBody({ slug: "x", title: "X", subject: { kind: "WRITER", providerId: "extra" } })).toBeNull();
    expect(parseGuideCreateBody({ slug: "x", title: "X", subject: { kind: "WRITER" }, publish: true })).toBeNull();
    expect(parseGuideCreateBody({ slug: "x", title: "X", subject: { kind: "WRITER" }, content: { markdown: "", html: "unsafe" } })).toBeNull();
  });

  it("requires a complete draft snapshot and revision for patch", () => {
    expect(parseGuidePatchBody({
      slug: "synthetic-walk",
      title: "Synthetic walk",
      description: "",
      content: { markdown: "" },
      expectedRevision: 3,
    })).toEqual({
      draft: { slug: "synthetic-walk", title: "Synthetic walk", description: "", content: { markdown: "" } },
      expectedRevision: 3,
    });
    expect(parseGuidePatchBody({ slug: "synthetic-walk", title: "Synthetic walk", expectedRevision: 3 })).toBeNull();
    expect(parseGuidePatchBody({
      slug: "synthetic-walk",
      title: "Synthetic walk",
      description: "",
      content: { markdown: "" },
      expectedRevision: 3,
      visibility: "PUBLIC",
    })).toBeNull();
  });

  it("accepts only exact positive-revision publication commands", () => {
    expect(parseGuidePublicationInput({ expectedRevision: 3, visibility: "PUBLIC" })).toEqual({
      expectedRevision: 3,
      visibility: "PUBLIC",
    });
    expect(parseGuidePublicationInput({ expectedRevision: 4, visibility: "UNLISTED" })).toEqual({
      expectedRevision: 4,
      visibility: "UNLISTED",
    });
    expect(parseGuidePublicationInput({ expectedRevision: 1, visibility: "PUBLIC", productLinks: [] })).toBeNull();
    expect(parseGuidePublicationInput({ expectedRevision: 0, visibility: "PUBLIC" })).toBeNull();
    expect(parseGuidePublicationInput({ expectedRevision: 1.5, visibility: "PUBLIC" })).toBeNull();
    expect(parseGuidePublicationInput({ expectedRevision: Number.MAX_SAFE_INTEGER + 1, visibility: "PUBLIC" })).toBeNull();
    expect(parseGuidePublicationInput({ expectedRevision: 1, visibility: "PRIVATE" })).toBeNull();

    expect(parseGuideStopPublicationInput({ expectedRevision: 5 })).toEqual({ expectedRevision: 5 });
    expect(parseGuideStopPublicationInput({ expectedRevision: 5, visibility: "PUBLIC" })).toBeNull();
    expect(parseGuideStopPublicationInput({ expectedRevision: -1 })).toBeNull();
  });
});
