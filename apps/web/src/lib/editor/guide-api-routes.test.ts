import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ repositoryFactory: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ guideRepository: mocks.repositoryFactory }));

import { GET as listGuides, POST as createGuide } from "@/app/(editor)/editor/api/guides/route";
import { GET as getGuide, PATCH as patchGuide } from "@/app/(editor)/editor/api/guides/[articleId]/route";
import { GET as getCategories } from "@/app/(editor)/editor/api/guides/categories/route";
import { GET as getSubjects } from "@/app/(editor)/editor/api/guides/subjects/route";
import { GET as getLinkableProducts } from "@/app/(editor)/editor/api/guides/[articleId]/linkable-products/route";
import { GET as getPublicationPreflight } from "@/app/(editor)/editor/api/guides/[articleId]/publication/preflight/route";
import { DELETE as stopGuidePublication, POST as publishGuide } from "@/app/(editor)/editor/api/guides/[articleId]/publication/route";

const SITE = "https://experience.example.invalid";
const context = { params: Promise.resolve({ articleId: "article-synthetic" }) };
const mutation = (path: string, method: "POST" | "PATCH" | "DELETE") => new Request(`${SITE}${path}`, {
  method,
  headers: { "content-type": "application/json", origin: SITE, "sec-fetch-site": "same-origin" },
  body: JSON.stringify({ expectedRevision: 1, title: "must-not-write" }),
});

describe("retired private editor guide routes", () => {
  it("returns 410 from every read and write route before session, body, or Store work", async () => {
    const responses = await Promise.all([
      listGuides(),
      createGuide(mutation("/editor/api/guides", "POST")),
      getGuide(new Request(`${SITE}/editor/api/guides/article-synthetic`), context),
      patchGuide(mutation("/editor/api/guides/article-synthetic", "PATCH"), context),
      getCategories(),
      getSubjects(),
      getLinkableProducts(new Request(`${SITE}/editor/api/guides/article-synthetic/linkable-products`), context),
      getPublicationPreflight(new Request(`${SITE}/editor/api/guides/article-synthetic/publication/preflight`), context),
      publishGuide(mutation("/editor/api/guides/article-synthetic/publication", "POST"), context),
      stopGuidePublication(mutation("/editor/api/guides/article-synthetic/publication", "DELETE"), context),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "gone" });
    }
    expect(mocks.repositoryFactory).not.toHaveBeenCalled();
  });
});
