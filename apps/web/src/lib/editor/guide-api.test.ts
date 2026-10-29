import { describe, expect, it } from "vitest";
import { parseGuideCreateBody, parseGuidePatchBody } from "./guide-api";

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
});
