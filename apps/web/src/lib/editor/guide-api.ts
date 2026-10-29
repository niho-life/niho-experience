import type {
  CreateGuideArticleInput,
  GuideArticleRecord,
  GuideAuthor,
  GuideContent,
  GuideDraftCover,
  GuideProductLinkInput,
  GuideSubject,
  SaveGuideDraftInput,
} from "@niho-experience/experience-store";

type JsonObject = Record<string, unknown>;

export type GuideCreateBody = Omit<CreateGuideArticleInput, "id">;

export interface GuidePatchBody {
  readonly draft: SaveGuideDraftInput;
  readonly expectedRevision: number;
}

function objectWithKeys(value: unknown, allowed: readonly string[]): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value as JsonObject;
  return Object.keys(object).every((key) => allowed.includes(key)) ? object : null;
}

function parseAuthor(value: unknown): GuideAuthor | null {
  const author = objectWithKeys(value, ["name", "role", "bio"]);
  if (!author || Object.keys(author).length !== 3) return null;
  if (typeof author.name !== "string" || typeof author.role !== "string" || typeof author.bio !== "string") return null;
  return { name: author.name, role: author.role, bio: author.bio };
}

function parseContent(value: unknown): GuideContent | null {
  const content = objectWithKeys(value, ["markdown", "author", "checkedOn"]);
  if (!content || typeof content.markdown !== "string") return null;
  let author: GuideAuthor | undefined;
  if (content.author !== undefined) {
    const parsed = parseAuthor(content.author);
    if (!parsed) return null;
    author = parsed;
  }
  if (content.checkedOn !== undefined && typeof content.checkedOn !== "string") return null;
  return {
    markdown: content.markdown,
    ...(author === undefined ? {} : { author }),
    ...(content.checkedOn === undefined ? {} : { checkedOn: content.checkedOn }),
  };
}

function parseSubject(value: unknown): GuideSubject | null {
  const subject = objectWithKeys(value, ["kind", "providerId"]);
  if (!subject) return null;
  if (subject.kind === "WRITER" && Object.keys(subject).length === 1) return { kind: "WRITER" };
  if (subject.kind === "PROVIDER" && Object.keys(subject).length === 2 && typeof subject.providerId === "string") {
    return { kind: "PROVIDER", providerId: subject.providerId };
  }
  return null;
}

function parseCover(value: unknown): GuideDraftCover | null {
  const cover = objectWithKeys(value, ["assetId", "alt", "credit", "webConfirmed"]);
  if (!cover || Object.keys(cover).length !== 4) return null;
  if (
    typeof cover.assetId !== "string"
    || typeof cover.alt !== "string"
    || typeof cover.credit !== "string"
    || typeof cover.webConfirmed !== "boolean"
  ) return null;
  return {
    assetId: cover.assetId,
    alt: cover.alt,
    credit: cover.credit,
    webConfirmed: cover.webConfirmed,
  };
}

function parseProductLinks(value: unknown): readonly GuideProductLinkInput[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const links: GuideProductLinkInput[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    const link = objectWithKeys(candidate, ["providerId", "productId"]);
    if (!link || Object.keys(link).length !== 2 || typeof link.providerId !== "string" || typeof link.productId !== "string") {
      return null;
    }
    const key = `${link.providerId}\u0000${link.productId}`;
    if (keys.has(key)) return null;
    keys.add(key);
    links.push({ providerId: link.providerId, productId: link.productId });
  }
  return links;
}

export function parseGuideCreateBody(value: unknown): GuideCreateBody | null {
  const body = objectWithKeys(value, ["slug", "title", "subject", "description", "categorySlug", "content"]);
  if (!body || typeof body.slug !== "string" || typeof body.title !== "string") return null;
  const subject = parseSubject(body.subject);
  if (!subject) return null;
  if (body.description !== undefined && typeof body.description !== "string") return null;
  if (body.categorySlug !== undefined && typeof body.categorySlug !== "string") return null;
  let content: GuideContent | undefined;
  if (body.content !== undefined) {
    const parsed = parseContent(body.content);
    if (!parsed) return null;
    content = parsed;
  }
  return {
    slug: body.slug,
    title: body.title,
    subject,
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.categorySlug === undefined ? {} : { categorySlug: body.categorySlug }),
    ...(content === undefined ? {} : { content }),
  };
}

export function parseGuidePatchBody(value: unknown): GuidePatchBody | null {
  const body = objectWithKeys(value, ["slug", "title", "description", "categorySlug", "content", "cover", "draftProductLinks", "expectedRevision"]);
  if (!body || typeof body.slug !== "string" || typeof body.title !== "string" || typeof body.description !== "string") return null;
  if (body.categorySlug !== undefined && typeof body.categorySlug !== "string") return null;
  if (typeof body.expectedRevision !== "number") return null;
  const content = parseContent(body.content);
  if (!content) return null;
  let cover: GuideDraftCover | null | undefined;
  if (body.cover === null) cover = null;
  else if (body.cover !== undefined) {
    cover = parseCover(body.cover);
    if (!cover) return null;
  }
  let draftProductLinks: readonly GuideProductLinkInput[] | undefined;
  if (body.draftProductLinks !== undefined) {
    const parsed = parseProductLinks(body.draftProductLinks);
    if (!parsed) return null;
    draftProductLinks = parsed;
  }
  return {
    draft: {
      slug: body.slug,
      title: body.title,
      description: body.description,
      ...(body.categorySlug === undefined ? {} : { categorySlug: body.categorySlug }),
      content,
      ...(cover === undefined ? {} : { cover }),
      ...(draftProductLinks === undefined ? {} : { draftProductLinks }),
    },
    expectedRevision: body.expectedRevision,
  };
}

export function privateGuideArticle(article: GuideArticleRecord) {
  return {
    id: article.id,
    slug: article.slug,
    subject: article.subject,
    title: article.title,
    description: article.description,
    ...(article.categorySlug === undefined ? {} : { categorySlug: article.categorySlug }),
    content: article.content,
    ...(article.cover === undefined ? {} : { cover: article.cover }),
    draftProductLinks: article.draftProductLinks,
    status: article.status,
    revision: article.revision,
    ...(article.currentPublication === undefined ? {} : { currentPublication: article.currentPublication }),
    createdAtUtc: article.createdAtUtc,
    updatedAtUtc: article.updatedAtUtc,
  };
}
