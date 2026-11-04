import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { apiMode: "http", publicApiVersion: "1.2", nihoWebOrigin: "https://niho.example" },
  list: vi.fn(),
  detail: vi.fn(),
  legacyClient: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./config", () => ({ config: state.config }));
vi.mock("@niho-experience/api-client", () => ({ createExperienceApiClient: state.legacyClient }));
vi.mock("./experience/publication-site", () => ({ listPublicationSummaries: state.list, getPublicationDetail: state.detail }));

import { getExperienceForSite, listExperiencesForSite } from "./api";

beforeEach(() => {
  vi.clearAllMocks();
  state.list.mockResolvedValue([{ slug: "published-only" }]);
  state.detail.mockResolvedValue({ slug: "published-only" });
});

it("reads the HTTP catalog and detail only from Experience publication", async () => {
  expect(await listExperiencesForSite("kamakura")).toEqual({ ok: true, data: { experiences: [{ slug: "published-only" }] } });
  expect(await getExperienceForSite("published-only")).toEqual({ ok: true, data: { experience: { slug: "published-only" } } });
  expect(state.legacyClient).not.toHaveBeenCalled();
});

it("closes an unpublished slug or store failure without calling the old NIHO API", async () => {
  state.detail.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("store unavailable"));
  state.list.mockRejectedValueOnce(new Error("store unavailable"));
  expect(await getExperienceForSite("old-only")).toEqual({ ok: false, kind: "not_found" });
  expect(await getExperienceForSite("old-only")).toEqual({ ok: false, kind: "network_error" });
  expect(await listExperiencesForSite("kamakura")).toEqual({ ok: false, kind: "network_error" });
  expect(state.legacyClient).not.toHaveBeenCalled();
});
