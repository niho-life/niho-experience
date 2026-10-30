import { GUIDE_LIMITS } from "../guides";
import { SITE_NAME } from "../public-metadata";
import { EDITOR_PUBLICATION_DEST, GUIDE_PREVIEW_TOKEN } from "./contract";

/**
 * What NIHO Experience requires of a publication, declared for editor.niho.life's "公開の前に" (#253, editor design §8.1).
 * The editor shows these conditions and their wording; this site only declares them. Provisional v1 (with the contract
 * in contract.ts): no secrets, the same for every caller, served by `GET /api/public/guides/publication-requirements`.
 *
 * On receipt this site re-checks only what keeps the page safe (English, the Markdown subset, https photos on the
 * editor's origins); the editorial conditions are the editor's gate.
 */

export const GUIDE_PREVIEW_PATH = "/guides/preview";
export const GUIDE_PREVIEW_TOKEN_PARAM = "token";

/** The preview token of a `/guides/preview` query: one well-formed value, or null (a 404 before anything is fetched). */
export function guidePreviewToken(query: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const value = query[GUIDE_PREVIEW_TOKEN_PARAM];
  return typeof value === "string" && GUIDE_PREVIEW_TOKEN.test(value) ? value : null;
}

export function guidePublicationRequirements(siteUrl: string) {
  return {
    version: 1,
    dest: EDITOR_PUBLICATION_DEST,
    label: SITE_NAME,
    origin: siteUrl,
    pathPrefix: "/guides",
    preview: { path: GUIDE_PREVIEW_PATH, tokenParam: GUIDE_PREVIEW_TOKEN_PARAM },
    conditions: [
      { id: "language-en", kind: "lang", equals: "en" },
      { id: "cover", kind: "cover", required: true, requireLicensed: true },
      { id: "lead", kind: "lead", required: true, maxLength: GUIDE_LIMITS.descriptionMaxLength },
      { id: "title", kind: "title", required: true, maxLength: GUIDE_LIMITS.titleMaxLength },
      { id: "category", kind: "category", required: true },
      { id: "heading", kind: "min-headings", min: 1 },
      { id: "no-confirm-marker", kind: "no-confirm-marker" },
      // The editor looks each related slug up there: the experience page is a 404 once the public API no longer lists it.
      { id: "related-experiences-listed", kind: "related-experiences-listed", lookup: `${siteUrl}/experiences/{slug}` },
    ],
  } as const;
}

export type GuidePublicationRequirements = ReturnType<typeof guidePublicationRequirements>;
