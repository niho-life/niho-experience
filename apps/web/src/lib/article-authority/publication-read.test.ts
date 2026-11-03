import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { articleAuthorityApiEnabled: true } }));

import type { ArticleAuthorityRepository } from "@niho-experience/experience-store";
import type { Guide } from "@/content/guides/types";
import { filterCurrentRelatedGuide, type PublicationReadDependencies } from "./publication-read";

const GUIDE = {
  slug: "synthetic-guide", title: "Synthetic guide", description: "Synthetic description", author: { name: "Synthetic Writer" },
  publishedAt: "2030-01-01", updatedAt: "2030-01-01", body: "## Body", faq: [], relatedGuideSlugs: [],
  relatedExperienceSlugs: ["allowed-trip", "revoked-trip"],
  editorPublication: { id: "00000000-0000-4000-8000-000000000042", version: 3 },
} as unknown as Guide;

function dependencies(links: { providerId: string; inviterNihoUserId: string }[] = [{ providerId: "allowed", inviterNihoUserId: "owner" }]): PublicationReadDependencies {
  const repository = {
    ownedProviderIds: vi.fn(async () => []),
    publishedProductsBySlugs: vi.fn(async () => [
      { providerId: "allowed", slug: "allowed-trip", title: "Allowed", providerName: "Allowed Provider" },
      { providerId: "revoked", slug: "revoked-trip", title: "Revoked", providerName: "Revoked Provider" },
    ]),
    activeOwnerIds: vi.fn(async () => new Map([["allowed", new Set(["owner"])], ["revoked", new Set(["owner"])] ])),
  } as unknown as ArticleAuthorityRepository;
  return {
    authority: vi.fn(async () => ({ writerNihoUserId: "writer", slugs: ["allowed-trip", "revoked-trip"] })),
    repository: () => repository,
    checkNiho: vi.fn(async () => ({ version: 1 as const, writer: true, links })),
  };
}

describe("filterCurrentRelatedGuide", () => {
  it("rechecks Editor, NIHO, Store publication and current OWNER without mutating the cached guide", async () => {
    const filtered = await filterCurrentRelatedGuide(GUIDE, dependencies());
    expect(filtered.relatedExperienceSlugs).toEqual(["allowed-trip"]);
    expect(GUIDE.relatedExperienceSlugs).toEqual(["allowed-trip", "revoked-trip"]);
    expect(filtered.title).toBe(GUIDE.title);
  });

  it("removes all related slugs on revocation, writer loss, unpublished products, or an authority outage while keeping the article", async () => {
    const revoked = await filterCurrentRelatedGuide(GUIDE, dependencies([]));
    expect(revoked.relatedExperienceSlugs).toEqual([]);
    expect(revoked.body).toBe(GUIDE.body);

    const outage = { ...dependencies(), authority: vi.fn(async () => { throw new Error("unavailable"); }) };
    const unavailable = await filterCurrentRelatedGuide(GUIDE, outage);
    expect(unavailable.relatedExperienceSlugs).toEqual([]);
    expect(unavailable.body).toBe(GUIDE.body);
  });
});
