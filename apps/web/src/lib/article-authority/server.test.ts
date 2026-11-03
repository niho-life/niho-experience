import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ArticleAuthorityRepository } from "@niho-experience/experience-store";
import { allowedRelatedSlugs, candidateItems, type ArticleAuthorityDependencies } from "./server";

type Candidate = { providerId: string; slug: string; title: string; providerName: string };

function dependencies(input: {
  candidates?: Candidate[];
  products?: Candidate[];
  owned?: string[];
  owners?: ReadonlyMap<string, ReadonlySet<string>>;
  writer?: boolean;
  links?: { providerId: string; inviterNihoUserId: string }[];
}) {
  const repository = {
    listPublishedCandidates: vi.fn(async () => input.candidates ?? []),
    publishedProductsBySlugs: vi.fn(async () => input.products ?? []),
    ownedProviderIds: vi.fn(async () => input.owned ?? []),
    activeOwnerIds: vi.fn(async () => input.owners ?? new Map()),
  } as unknown as ArticleAuthorityRepository;
  const checkNiho = vi.fn(async (_writer: string, providerIds: readonly string[]) => ({
    version: 1 as const,
    writer: input.writer ?? true,
    links: (input.links ?? []).filter((link) => providerIds.includes(link.providerId)),
  }));
  return { value: { repository, checkNiho } satisfies ArticleAuthorityDependencies, repository, checkNiho };
}

const item = (providerId: string, slug: string): Candidate => ({ providerId, slug, title: `Title ${slug}`, providerName: `Provider ${providerId}` });

describe("article authority candidates", () => {
  it("includes only current owner access or a current link whose inviter is still OWNER", async () => {
    const owners = new Map<string, ReadonlySet<string>>([["linked", new Set(["current-owner"])]]);
    const deps = dependencies({
      candidates: [item("owned", "owned-trip"), item("linked", "linked-trip"), item("other", "other-trip")],
      owned: ["owned"], owners,
      links: [{ providerId: "linked", inviterNihoUserId: "current-owner" }, { providerId: "other", inviterNihoUserId: "former-owner" }],
    });
    await expect(candidateItems({ writerNihoUserId: "writer" }, deps.value)).resolves.toEqual({
      version: 1,
      items: [
        { slug: "owned-trip", title: "Title owned-trip", providerName: "Provider owned" },
        { slug: "linked-trip", title: "Title linked-trip", providerName: "Provider linked" },
      ],
      nextCursor: null,
    });
  });

  it("removes owner and linked candidates when the writer role is currently absent", async () => {
    const deps = dependencies({ candidates: [item("owned", "owned-trip")], owned: ["owned"], writer: false });
    await expect(candidateItems({ writerNihoUserId: "writer" }, deps.value)).resolves.toEqual({ version: 1, items: [], nextCursor: null });
  });

  it("does not authorize ambiguous slugs and keeps a keyset cursor without skipping the 21st allowed item", async () => {
    const rows = [item("a", "ambiguous"), item("b", "ambiguous"), ...Array.from({ length: 21 }, (_, index) => item("owned", `trip-${String(index).padStart(2, "0")}`))];
    const deps = dependencies({ candidates: rows, owned: ["owned", "a", "b"] });
    const result = await candidateItems({ writerNihoUserId: "writer" }, deps.value);
    expect(result.items).toHaveLength(20);
    expect(result.items.some((candidate) => candidate.slug === "ambiguous")).toBe(false);
    expect(result.nextCursor).toBe("trip-19");
  });

  it("checks NIHO in groups of at most 32 providers", async () => {
    const rows = Array.from({ length: 65 }, (_, index) => item(`provider-${index}`, `trip-${String(index).padStart(2, "0")}`));
    const deps = dependencies({ candidates: rows, owned: rows.map((row) => row.providerId) });
    await candidateItems({ writerNihoUserId: "writer" }, deps.value);
    expect(deps.checkNiho.mock.calls.map((call) => call[1].length)).toEqual([32, 32, 1]);
  });
});

describe("article authority related checks", () => {
  it("preserves requested order while excluding unpublished, ambiguous, other-provider, and revoked links", async () => {
    const products = [item("owned", "owned-trip"), item("linked", "linked-trip"), item("other", "other-trip"), item("dup-a", "ambiguous"), item("dup-b", "ambiguous")];
    const deps = dependencies({
      products,
      owned: ["owned"],
      owners: new Map([["linked", new Set(["current-owner"])]]),
      links: [{ providerId: "linked", inviterNihoUserId: "current-owner" }],
    });
    await expect(allowedRelatedSlugs("writer", ["linked-trip", "missing", "ambiguous", "other-trip", "owned-trip"], deps.value))
      .resolves.toEqual(["linked-trip", "owned-trip"]);

    const revoked = dependencies({ products, owned: ["owned"], owners: new Map([["linked", new Set(["current-owner"])]]), links: [] });
    await expect(allowedRelatedSlugs("writer", ["linked-trip", "owned-trip"], revoked.value)).resolves.toEqual(["owned-trip"]);
  });
});
