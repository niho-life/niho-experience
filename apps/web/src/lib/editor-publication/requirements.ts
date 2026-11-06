import { GUIDE_LIMITS } from "../guides";
import { SITE_NAME } from "../public-metadata";
import { EDITOR_PUBLICATION_DEST, GUIDE_PREVIEW_TOKEN } from "./contract";

/**
 * What NIHO Experience requires of a publication, declared for editor.niho.life's "公開の前に" (#253): a destination
 * declaration (niho-life/niho-editor packages/editor-publish `DestinationDeclaration`, schema version 1). The editor's
 * vocabulary is closed: an unknown kind or field rejects the whole declaration there, so only its kinds and fields appear
 * here. The editor shows these conditions and their wording; this site only declares them. No secrets, the same for every
 * caller, served by `GET /api/public/guides/publication-requirements`.
 *
 * On receipt this site re-checks only what keeps the page safe and listable (English, a title and an optional lead within
 * the product limits, a category, the Markdown subset, https photos on the editor's origins); the editorial conditions are
 * the editor's gate. Cover and lead are optional for this destination. `title` and `images` need an editor that knows
 * those kinds (niho-life/niho-editor#316): an older editor rejects the whole declaration.
 */

export const GUIDE_PREVIEW_TOKEN_PARAM = "token";

/** The preview token of a `/guides/preview` query: one well-formed value, or null (a 404 before anything is fetched). */
export function guidePreviewToken(query: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const value = query[GUIDE_PREVIEW_TOKEN_PARAM];
  return typeof value === "string" && GUIDE_PREVIEW_TOKEN.test(value) ? value : null;
}

export interface GuidePublicationCategoryOption {
  readonly slug: string;
  readonly labelEn: string;
  readonly labelJa: string;
  readonly displayOrder: number;
  readonly revision: number;
}

export function guidePublicationRequirements(siteUrl: string, categories: readonly GuidePublicationCategoryOption[] = []) {
  const leadMax = GUIDE_LIMITS.descriptionMaxLength;
  const titleMax = GUIDE_LIMITS.titleMaxLength;
  return {
    schemaVersion: 1,
    id: EDITOR_PUBLICATION_DEST,
    label: SITE_NAME,
    host: new URL(siteUrl).host,
    path: "guides",
    ranges: ["live", "unlisted"],
    extras: ["app"],
    // The editor's quote, divider, strike and code have no place on a guide page.
    accepts: { blocks: ["paragraph", "heading", "list", "figure", "note"], marks: ["bold", "italic", "link"] },
    requires: [
      { id: "lang-en", kind: "lang", equals: "en", message: "英語で書いてください", fix: "lang" },
      { id: "cover", kind: "cover", consent: true, message: "カバー写真を設定する場合は掲載許諾を確認してください", fix: "cover" },
      { id: "lead", kind: "lead", max: leadMax, message: `リードを設定する場合は ${leadMax} 字以内にしてください`, fix: "lead" },
      { id: "category", kind: "category", oneOf: categories.map((item) => item.slug), message: "カテゴリを選んでください", fix: "category" },
      { id: "headings", kind: "headings", min: 1, message: "本文に見出しを 1 つ以上入れてください", fix: "body" },
      { id: "no-confirm", kind: "noConfirm", message: "未確認の印（CONFIRM）を解消してください", fix: "body" },
      // No `relatedLive`: a related experience is optional (owner 2026-11-07), and the editor's `relatedLive` would require one.
      // A related experience still links only when this site re-checks the writer's permission and the listing on read (#255).
      // This site leaves out a publication whose title is longer (the `Article.headline` limit): stop it in the editor instead.
      { id: "title", kind: "title", max: titleMax, message: `題名を ${titleMax} 字以内にしてください`, fix: "body" },
      // Every photo (body and cover) needs alt text: the page's only description of a photo for search and screen readers.
      { id: "image-alt", kind: "images", alt: true, message: "写真に代替テキスト（alt）を入れてください", fix: "body" },
    ],
  } as const;
}

export type GuidePublicationRequirements = ReturnType<typeof guidePublicationRequirements>;
