import type { Guide, GuideAuthor, GuideHero } from "@/content/guides/types";
import { GUIDE_ASSET_URI_PREFIX, GuideMarkdownError, guideLinkHref, parseGuideMarkdown } from "../guide-markdown";
import type { EditorArticle, EditorAsset, EditorAuthor, EditorPreview } from "./contract";

/**
 * Editor publications → the one display model every guide uses (pure). The body is rendered by the same safe Markdown
 * renderer as static and database guides; no HTML or AST from the editor reaches the page. Photos must be https URLs on
 * the configured editor origins: a site path, another host or an internal `niho-guide-asset:` reference is refused.
 */

export type EditorPhotoPolicy = Readonly<{ assetOrigins: readonly string[] }>;

export type EditorGuideResult = Readonly<{ ok: true; guide: Guide }> | Readonly<{ ok: false; reason: string }>;
/** `detail` is the writer-facing explanation (a Markdown error with its line), shown on the preview only. */
export type EditorPreviewGuideResult = Readonly<{ ok: true; guide: Guide }> | Readonly<{ ok: false; reason: string; detail: string }>;

/** Default display order for a category without one: after every ordered category. */
export const EDITOR_CATEGORY_DEFAULT_ORDER = 1000;

/**
 * The size a cover is declared with. Contract v1 sends no pixel size for a photo, and `<img>` needs one; the page lays the
 * hero out with `h-auto`, so the photo still shows in its own ratio. The hero says `sizeAssumed`, so a share image never
 * declares this size as the photo's (the Open Graph image goes without width and height).
 */
export const EDITOR_COVER_ASSUMED_SIZE = { width: 1600, height: 900 } as const;

/** The photo URL to render, or null unless it is an https URL on an allowed editor origin. */
export function editorPhotoUrl(url: string, policy: EditorPhotoPolicy): string | null {
  const href = guideLinkHref(url);
  if (!href?.external) return null;
  return policy.assetOrigins.includes(new URL(href.href).origin) ? href.href : null;
}

type Problem = Readonly<{ reason: string; detail: string }>;

/** The safety checks shared by publications and previews: the Markdown subset, then every photo's origin. */
function contentProblem(markdown: string, cover: EditorAsset | undefined, assets: readonly EditorAsset[], policy: EditorPhotoPolicy): Problem | null {
  let blocks;
  try {
    blocks = parseGuideMarkdown(markdown);
  } catch (error) {
    if (error instanceof GuideMarkdownError) return { reason: `markdown is outside the guide subset at line ${error.line}`, detail: error.message };
    return { reason: "markdown could not be read", detail: "The body could not be read." };
  }
  for (const block of blocks) {
    if (block.type !== "figure") continue;
    if (block.assetId !== undefined || block.src.startsWith(GUIDE_ASSET_URI_PREFIX)) {
      return { reason: "a body photo uses an internal guide asset reference", detail: "A body photo points at an internal guide asset; publish it as an editor photo URL." };
    }
    if (!block.external || !editorPhotoUrl(block.src, policy)) {
      return { reason: "a body photo is not an https URL on an allowed host", detail: "A body photo is not an https URL from the editor's photo storage." };
    }
  }
  if (cover && !editorPhotoUrl(cover.url, policy)) return { reason: "cover is not an https URL on an allowed host", detail: "The cover photo is not an https URL from the editor's photo storage." };
  if (assets.some((item) => !editorPhotoUrl(item.url, policy))) return { reason: "an asset is not an https URL on an allowed host", detail: "A photo is not an https URL from the editor's photo storage." };
  return null;
}

function hero(cover: EditorAsset, shareable: boolean, policy: EditorPhotoPolicy): GuideHero {
  return {
    src: editorPhotoUrl(cover.url, policy)!,
    alt: cover.alt,
    ...EDITOR_COVER_ASSUMED_SIZE,
    sizeAssumed: true,
    // Only an explicit declaration of sharing rights opens Open Graph and `Article.image` (shareableGuideImage). The
    // editor's consent alone is permission to publish on the page; `coverShareable` is the writer's separate permission to
    // share the cover too, so only that makes it licensed.
    licensed: shareable,
    ...(cover.credit === undefined ? {} : { caption: cover.credit }),
  };
}

/** The author as the page shows them: the name, and the role and introduction when the writer published them. */
function guideAuthor(author: EditorAuthor): GuideAuthor {
  return { name: author.name, ...(author.role === undefined ? {} : { role: author.role }), ...(author.bio === undefined ? {} : { bio: author.bio }) };
}

const dateOf = (isoTime: string) => isoTime.slice(0, 10);

/** One published article (list fields + body) as a guide, or why it is left out. */
export function editorArticleToGuide(article: EditorArticle, policy: EditorPhotoPolicy): EditorGuideResult {
  if (!article.markdown.trim()) return { ok: false, reason: "markdown is empty" };
  const problem = contentProblem(article.markdown, article.cover, article.assets, policy);
  if (problem) return { ok: false, reason: problem.reason };
  return {
    ok: true,
    guide: {
      slug: article.slug,
      ...(article.range === "unlisted" ? { unlisted: true as const } : {}),
      title: article.title,
      description: article.lead ?? "",
      category: { slug: article.category.slug, label: article.category.label, ...(article.category.labelJa === undefined ? {} : { labelJa: article.category.labelJa }), displayOrder: article.category.order ?? EDITOR_CATEGORY_DEFAULT_ORDER, ...(article.category.revision === undefined ? {} : { revision: article.category.revision }) },
      editorPublication: { id: article.id, version: article.version },
      author: guideAuthor(article.author),
      publishedAt: dateOf(article.publishedAt),
      updatedAt: dateOf(article.updatedAt),
      ...(article.cover ? { hero: hero(article.cover, article.coverShareable === true, policy) } : {}),
      relatedExperienceSlugs: [...new Set(article.related)],
      relatedGuideSlugs: [],
      faq: [],
      body: article.markdown,
    },
  };
}

/** The slug a preview renders under when the draft has none yet (never linked: the preview has no canonical or JSON-LD). */
export const EDITOR_PREVIEW_SLUG = "preview";
export const EDITOR_PREVIEW_AUTHOR = { name: "Author not set" } as const;

/**
 * A draft as a guide for `/guides/preview`. Missing lead, cover, category, author or related experiences are filled with
 * neutral defaults (the publication conditions are the editor's checklist, not the preview's), but the safety checks are
 * the same as for a publication.
 */
export function editorPreviewToGuide(preview: EditorPreview, policy: EditorPhotoPolicy, today: string): EditorPreviewGuideResult {
  const problem = contentProblem(preview.markdown, preview.cover, preview.assets, policy);
  if (problem) return { ok: false, ...problem };
  const publishedAt = preview.publishedAt ? dateOf(preview.publishedAt) : today;
  return {
    ok: true,
    guide: {
      slug: preview.slug ?? EDITOR_PREVIEW_SLUG,
      unlisted: true,
      title: preview.title,
      description: preview.lead ?? "",
      ...(preview.category
        ? { category: { slug: preview.category.slug, label: preview.category.label, displayOrder: preview.category.order ?? EDITOR_CATEGORY_DEFAULT_ORDER } }
        : {}),
      author: preview.author ? guideAuthor(preview.author) : EDITOR_PREVIEW_AUTHOR,
      publishedAt,
      updatedAt: today < publishedAt ? publishedAt : today,
      ...(preview.cover ? { hero: hero(preview.cover, preview.coverShareable === true, policy) } : {}),
      relatedExperienceSlugs: [...preview.related],
      relatedGuideSlugs: [],
      faq: [],
      body: preview.markdown,
    },
  };
}
