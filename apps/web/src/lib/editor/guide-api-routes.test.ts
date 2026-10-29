import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  load: vi.fn(),
  clear: vi.fn(),
  allowed: vi.fn(() => true),
  repositoryFactory: vi.fn(),
  repository: {
    listArticles: vi.fn(),
    createArticle: vi.fn(),
    getArticle: vi.fn(),
    saveDraft: vi.fn(),
    commitPublication: vi.fn(),
    stopPublication: vi.fn(),
    listActiveCategories: vi.fn(),
    listWritableSubjects: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/editor/server", () => ({
  isEditorConsole: mocks.enabled,
  loadEditorSession: mocks.load,
  clearEditorSessionCookie: mocks.clear,
  editorMutationAllowed: mocks.allowed,
}));
vi.mock("@/lib/experience/store-server", () => ({ guideRepository: mocks.repositoryFactory }));

import { GET as listGuides, POST as createGuide } from "@/app/(editor)/editor/api/guides/route";
import { GET as getGuide, PATCH as patchGuide } from "@/app/(editor)/editor/api/guides/[articleId]/route";
import { GET as getCategories } from "@/app/(editor)/editor/api/guides/categories/route";
import { GET as getSubjects } from "@/app/(editor)/editor/api/guides/subjects/route";
import { GET as getPublicationPreflight } from "@/app/(editor)/editor/api/guides/[articleId]/publication/preflight/route";
import { DELETE as stopGuidePublication, POST as publishGuide } from "@/app/(editor)/editor/api/guides/[articleId]/publication/route";

const SITE = "https://experience.example.test";
const mutationHeaders = {
  origin: SITE,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};
const context = { params: Promise.resolve({ articleId: "article-synthetic" }) };
const article = {
  id: "article-synthetic",
  slug: "synthetic-guide",
  creatorNihoUserId: "writer-synthetic",
  subject: { kind: "WRITER" as const },
  title: "Synthetic guide",
  description: "Test-only guide.",
  content: { markdown: "## Synthetic" },
  status: "DRAFT" as const,
  revision: 2,
  createdAtUtc: "2026-10-29T00:00:00.000Z",
  updatedAtUtc: "2026-10-29T01:00:00.000Z",
};

function jsonRequest(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown, headers = mutationHeaders) {
  return new Request(`${SITE}${path}`, { method, headers, body: JSON.stringify(body) });
}

const publishableArticle = {
  ...article,
  categorySlug: "walks",
  content: {
    markdown: "## Synthetic\n\nSafe test content.",
    author: { name: "Synthetic Writer", role: "Guide", bio: "Test-only profile." },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.allowed.mockReturnValue(true);
  mocks.repositoryFactory.mockReturnValue(mocks.repository);
  mocks.load.mockResolvedValue({
    status: "ok",
    session: { actorId: "writer-synthetic" },
    verified: {},
  });
  mocks.repository.listArticles.mockResolvedValue([article]);
  mocks.repository.createArticle.mockResolvedValue({ ...article, revision: 1 });
  mocks.repository.getArticle.mockResolvedValue(article);
  mocks.repository.saveDraft.mockResolvedValue({ ...article, revision: 3 });
  mocks.repository.commitPublication.mockResolvedValue({
    articleId: article.id,
    publicationId: 1,
    publicationNumber: 1,
    sourceRevision: 2,
    slug: article.slug,
    subject: article.subject,
    category: { slug: "walks", labelEn: "Walks", labelJa: "散歩", displayOrder: 10 },
    title: article.title,
    description: article.description,
    content: publishableArticle.content,
    visibility: "PUBLIC",
    indexable: true,
    productLinks: [],
    publishedAtUtc: "2026-10-29T02:00:00.000Z",
  });
  mocks.repository.stopPublication.mockResolvedValue({ ...publishableArticle, status: "STOPPED", revision: 4 });
  mocks.repository.listActiveCategories.mockResolvedValue([{ slug: "walks", labelEn: "Walks", labelJa: "散歩", displayOrder: 10 }]);
  mocks.repository.listWritableSubjects.mockResolvedValue([{ kind: "WRITER" }]);
});

describe("private editor guide routes", () => {
  it("checks the current NIHO session on every endpoint and uses no-store responses", async () => {
    mocks.load.mockResolvedValue({ status: "signed-out" });
    const responses = await Promise.all([
      listGuides(),
      createGuide(jsonRequest("/editor/api/guides", "POST", { slug: "x", title: "X", subject: { kind: "WRITER" } })),
      getGuide(new Request(`${SITE}/editor/api/guides/article-synthetic`), context),
      patchGuide(jsonRequest("/editor/api/guides/article-synthetic", "PATCH", {
        slug: "x", title: "X", description: "", content: { markdown: "" }, expectedRevision: 1,
      }), context),
      getCategories(),
      getSubjects(),
      getPublicationPreflight(new Request(`${SITE}/editor/api/guides/article-synthetic/publication/preflight`), context),
      publishGuide(jsonRequest("/editor/api/guides/article-synthetic/publication", "POST", {
        expectedRevision: 2, visibility: "PUBLIC",
      }), context),
      stopGuidePublication(jsonRequest("/editor/api/guides/article-synthetic/publication", "DELETE", {
        expectedRevision: 2,
      }), context),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401]);
    expect(responses.every((response) => response.headers.get("cache-control") === "private, no-store")).toBe(true);
    expect(responses.every((response) => response.headers.get("x-robots-tag") === "noindex, nofollow")).toBe(true);
    expect(mocks.load).toHaveBeenCalledTimes(9);

    mocks.load.mockResolvedValue({ status: "rejected" });
    expect((await listGuides()).status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    mocks.load.mockResolvedValue({ status: "refresh", session: { actorId: "writer-synthetic" } });
    expect(await (await listGuides()).json()).toEqual({ error: "refresh_required" });
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    mocks.load.mockResolvedValue({ status: "error" });
    expect((await listGuides()).status).toBe(503);
    expect(mocks.clear).toHaveBeenCalledTimes(1);

    mocks.load.mockResolvedValue({ status: "ok", session: { actorId: "writer-synthetic" }, verified: {} });
    mocks.repositoryFactory.mockReturnValue(null);
    expect((await listGuides()).status).toBe(503);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it("lists, creates, reads, saves, and exposes only current choices", async () => {
    expect(await (await listGuides()).json()).toEqual({ guides: [{
      id: article.id,
      slug: article.slug,
      subject: article.subject,
      title: article.title,
      description: article.description,
      content: article.content,
      status: article.status,
      revision: article.revision,
      createdAtUtc: article.createdAtUtc,
      updatedAtUtc: article.updatedAtUtc,
    }] });
    const created = await createGuide(jsonRequest("/editor/api/guides", "POST", {
      slug: "synthetic-guide",
      title: "Synthetic guide",
      subject: { kind: "WRITER" },
    }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: article.id, revision: 1 });
    const createInput = mocks.repository.createArticle.mock.calls[0]![1];
    expect(createInput.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(createInput).toMatchObject({ slug: "synthetic-guide", subject: { kind: "WRITER" } });

    expect((await getGuide(new Request(`${SITE}/editor/api/guides/article-synthetic`), context)).status).toBe(200);
    const patched = await patchGuide(jsonRequest("/editor/api/guides/article-synthetic", "PATCH", {
      slug: "synthetic-guide",
      title: "Synthetic guide",
      description: "Test-only guide.",
      content: { markdown: "## Synthetic" },
      expectedRevision: 2,
    }), context);
    expect(await patched.json()).toEqual({ id: article.id, revision: 3 });
    expect(mocks.repository.saveDraft).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" },
      "article-synthetic",
      expect.objectContaining({ slug: "synthetic-guide", content: { markdown: "## Synthetic" } }),
      2,
    );
    expect(await (await getCategories()).json()).toEqual({ categories: [{ slug: "walks", labelEn: "Walks", labelJa: "散歩", displayOrder: 10 }] });
    expect(await (await getSubjects()).json()).toEqual({ subjects: [{ kind: "WRITER" }] });
    expect(mocks.repository.listWritableSubjects).toHaveBeenCalledWith("writer-synthetic");
  });

  it("rejects cross-site, malformed, extra-field, oversized, and invalid UTF-8 mutations", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await createGuide(jsonRequest("/editor/api/guides", "POST", {
      slug: "x", title: "X", subject: { kind: "WRITER" },
    }))).status).toBe(403);
    mocks.allowed.mockReturnValue(true);

    expect((await createGuide(jsonRequest("/editor/api/guides", "POST", {
      slug: "x", title: "X", subject: { kind: "WRITER" }, publish: true,
    }))).status).toBe(400);
    expect((await patchGuide(jsonRequest("/editor/api/guides/article-synthetic", "PATCH", {
      slug: "x", title: "X", description: "", expectedRevision: 1,
    }), context)).status).toBe(400);

    const oversized = new Request(`${SITE}/editor/api/guides`, {
      method: "POST",
      headers: { ...mutationHeaders, "content-length": String(1024 * 1024 + 1) },
      body: "{}",
    });
    expect((await createGuide(oversized)).status).toBe(400);
    const actuallyOversized = new Request(`${SITE}/editor/api/guides`, {
      method: "POST",
      headers: mutationHeaders,
      body: new Uint8Array(1024 * 1024 + 1),
    });
    expect((await createGuide(actuallyOversized)).status).toBe(400);
    const invalidUtf8 = new Request(`${SITE}/editor/api/guides`, {
      method: "POST",
      headers: mutationHeaders,
      body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    });
    expect((await createGuide(invalidUtf8)).status).toBe(400);
    expect(mocks.repository.createArticle).not.toHaveBeenCalled();
  });

  it("maps store failures without exposing SQL or distinguishing missing from unauthorized", async () => {
    const cases = [
      [new StoreValidationError("raw validation detail"), 400, "invalid_input"],
      [new StoreConflictError("raw revision detail"), 409, "conflict"],
      [new StoreAccessDeniedError(), 404, "not_found"],
      [new StoreNotFoundError("private guide"), 404, "not_found"],
      [new Error("SELECT private FROM guides"), 503, "unavailable"],
    ] as const;
    for (const [error, status, code] of cases) {
      mocks.repository.getArticle.mockRejectedValueOnce(error);
      const response = await getGuide(new Request(`${SITE}/editor/api/guides/article-synthetic`), context);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }
  });

  it("preflights the owned saved article with private response boundaries", async () => {
    mocks.repository.getArticle.mockResolvedValue(publishableArticle);
    const response = await getPublicationPreflight(
      new Request(`${SITE}/editor/api/guides/article-synthetic/publication/preflight`),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.json()).toMatchObject({
      guide: { id: article.id, revision: 2 },
      problems: [],
    });
    expect(mocks.repository.getArticle).toHaveBeenCalledWith({ nihoUserId: "writer-synthetic" }, article.id);

    mocks.repository.getArticle.mockResolvedValue({ ...publishableArticle, description: "" });
    const invalid = await getPublicationPreflight(
      new Request(`${SITE}/editor/api/guides/article-synthetic/publication/preflight`),
      context,
    );
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ problems: [{ field: "description" }] });
  });

  it("publishes only a revalidated exact saved revision and never accepts product links", async () => {
    const publishedArticle = {
      ...publishableArticle,
      status: "PUBLISHED" as const,
      revision: 3,
      currentPublication: {
        id: 1,
        number: 1,
        visibility: "UNLISTED" as const,
        publishedAtUtc: "2026-10-29T02:00:00.000Z",
      },
    };
    mocks.repository.getArticle
      .mockResolvedValueOnce(publishableArticle)
      .mockResolvedValueOnce(publishedArticle);
    const response = await publishGuide(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "POST",
      { expectedRevision: 2, visibility: "UNLISTED" },
    ), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ guide: { status: "PUBLISHED", revision: 3 } });
    expect(mocks.repository.commitPublication).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" },
      article.id,
      { expectedRevision: 2, visibility: "UNLISTED", productLinks: [] },
    );

    const injected = await publishGuide(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "POST",
      { expectedRevision: 2, visibility: "PUBLIC", productLinks: [{ providerId: "p", productId: "x" }] },
    ), context);
    expect(injected.status).toBe(400);
    expect(mocks.repository.commitPublication).toHaveBeenCalledTimes(1);
  });

  it("returns validation and revision failures before the publication transaction", async () => {
    mocks.repository.getArticle.mockResolvedValue({
      ...publishableArticle,
      content: { ...publishableArticle.content, markdown: "## Unsafe\n\n<script>bad</script>" },
    });
    const invalid = await publishGuide(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "POST",
      { expectedRevision: 2, visibility: "PUBLIC" },
    ), context);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_input", problems: [{ field: "body" }] });
    expect(mocks.repository.commitPublication).not.toHaveBeenCalled();

    mocks.repository.getArticle.mockResolvedValue(publishableArticle);
    const conflict = await publishGuide(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "POST",
      { expectedRevision: 1, visibility: "PUBLIC" },
    ), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict" });
    expect(mocks.repository.commitPublication).not.toHaveBeenCalled();

    mocks.repository.getArticle.mockResolvedValue(publishableArticle);
    mocks.repository.commitPublication.mockRejectedValueOnce(new StoreConflictError("revision changed in transaction"));
    const transactionRace = await publishGuide(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "POST",
      { expectedRevision: 2, visibility: "PUBLIC" },
    ), context);
    expect(transactionRace.status).toBe(409);
    expect(await transactionRace.json()).toEqual({ error: "conflict" });
    expect(mocks.repository.commitPublication).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" },
      article.id,
      { expectedRevision: 2, visibility: "PUBLIC", productLinks: [] },
    );
  });

  it("stops publication through the store revision check and maps mutation boundaries", async () => {
    const response = await stopGuidePublication(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "DELETE",
      { expectedRevision: 3 },
    ), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ guide: { status: "STOPPED", revision: 4 } });
    expect(mocks.repository.stopPublication).toHaveBeenCalledWith(
      { nihoUserId: "writer-synthetic" },
      article.id,
      3,
    );

    mocks.allowed.mockReturnValue(false);
    expect((await stopGuidePublication(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "DELETE",
      { expectedRevision: 3 },
    ), context)).status).toBe(403);
    mocks.allowed.mockReturnValue(true);

    mocks.repository.stopPublication.mockRejectedValue(new StoreConflictError("private detail"));
    const conflict = await stopGuidePublication(jsonRequest(
      "/editor/api/guides/article-synthetic/publication",
      "DELETE",
      { expectedRevision: 3 },
    ), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict" });
  });
});
