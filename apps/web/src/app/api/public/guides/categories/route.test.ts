import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ repository: vi.fn() }));
vi.mock("@/lib/experience/store-server", () => ({ articleAuthorityRepository: mocks.repository }));

import { GET } from "./route";

beforeEach(() => { vi.clearAllMocks(); });

describe("GET /api/public/guides/categories", () => {
  it("returns only the bounded active-category projection without stale caching", async () => {
    mocks.repository.mockReturnValue({ listActiveCategories: async () => [{ slug: "walks", labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 }] });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: 1, items: [{ slug: "walks", labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 }] });
  });

  it("returns 503 when the Store contract is unavailable or fails", async () => {
    mocks.repository.mockReturnValueOnce(null);
    expect((await GET()).status).toBe(503);
    mocks.repository.mockReturnValueOnce({ listActiveCategories: async () => { throw new Error("unavailable"); } });
    expect((await GET()).status).toBe(503);
  });
});
