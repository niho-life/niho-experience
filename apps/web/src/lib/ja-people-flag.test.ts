import { beforeEach, describe, expect, it, vi } from "vitest";

/* 街の人のページを止める flag (#612): the data stays, the pages and what leads to them go; an experience keeps a person's name and face. */
const state = vi.hoisted(() => ({
  config: { peoplePagesEnabled: false },
  listPublic: vi.fn(),
  getPublicBySlug: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ peopleListingRepository: () => ({ listPublic: state.listPublic, getPublicBySlug: state.getPublicBySlug }) }));
vi.mock("@/lib/experience/site-publications", () => ({ listSitePublicExperiences: vi.fn(async () => ({ experiences: [] })) }));

import { loadPeople, loadPeoplePages, loadPerson } from "./ja-people";

const PERSON = { slug: "takuya", name: "高浜拓也", roleJa: "コミュニティマネージャー", areaJa: "鎌倉", quoteJa: null, introJa: null, photo: { src: "/p.jpg", altJa: "写真", credit: null }, experienceSlugs: [], sortOrder: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { peoplePagesEnabled: false };
  state.listPublic.mockResolvedValue([PERSON]);
  state.getPublicBySlug.mockResolvedValue(PERSON);
});

describe("the people pages' flag", () => {
  it("shows nobody on the pages (the home, the sitemap, the list) and finds no person while it is off, but still knows the people for an experience", async () => {
    expect(await loadPeoplePages()).toEqual([]);
    expect(await loadPerson("takuya")).toBeNull();
    expect(state.getPublicBySlug).not.toHaveBeenCalled();
    // The experience's 案内する人 and the cards' 「◯◯さんが案内」 read this: name and face stay.
    expect(await loadPeople()).toEqual([PERSON]);
  });

  it("brings the pages back when it is on", async () => {
    state.config = { peoplePagesEnabled: true };
    expect(await loadPeoplePages()).toEqual([PERSON]);
    expect(await loadPerson("takuya")).toMatchObject({ person: PERSON });
  });
});
