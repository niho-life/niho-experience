import type {
  CreateGuideArticleInput,
  GuideArticleRecord,
  GuideAuthor,
  GuideContent,
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
  const body = objectWithKeys(value, ["slug", "title", "description", "categorySlug", "content", "expectedRevision"]);
  if (!body || typeof body.slug !== "string" || typeof body.title !== "string" || typeof body.description !== "string") return null;
  if (body.categorySlug !== undefined && typeof body.categorySlug !== "string") return null;
  if (typeof body.expectedRevision !== "number") return null;
  const content = parseContent(body.content);
  if (!content) return null;
  return {
    draft: {
      slug: body.slug,
      title: body.title,
      description: body.description,
      ...(body.categorySlug === undefined ? {} : { categorySlug: body.categorySlug }),
      content,
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
    status: article.status,
    revision: article.revision,
    ...(article.currentPublication === undefined ? {} : { currentPublication: article.currentPublication }),
    createdAtUtc: article.createdAtUtc,
    updatedAtUtc: article.updatedAtUtc,
  };
}
