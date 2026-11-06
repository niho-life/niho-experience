import "server-only";

import { cache } from "react";
import {
  createStaticCopyV1,
  type StaticCopyAccessorV1,
  type StaticCopyValuesV1,
} from "@niho/experience-presentation/v1";
import type {
  ExperienceInterfaceCopyResponse,
  SelectedExperienceCatalogResponse,
  SelectedExperienceDetailResponse,
} from "@niho-experience/api-client";
import { config } from "./config";
import { getApi } from "./api";
import type { PageId } from "./page-document-contract";
import { assertSameJapaneseRelease, JapaneseReleaseUnavailable } from "./localized-release";
import { experienceCounterparts, mapJapaneseExperiences, mapPublicationJapaneseExperiences } from "./localized-mapping";
import { readBoundedJson } from "./read-bounded-json";
import { LOCAL_JAPANESE_RELEASE_ID, localJapaneseCopy } from "./ja-static-copy";
export { assertSameJapaneseRelease, JapaneseReleaseUnavailable, japaneseBookingAllowed } from "./localized-release";

export type SiteLocale = "en" | "ja";
export type JapanesePage = Readonly<{
  releaseId: string;
  locale: "ja";
  /** Archived visual payload. It is retained by the producer but never rendered. */
  document: unknown;
  route: { pageId: string; sourcePath: string; path: string; indexable: boolean };
  seo: { pageId: string; title: string; description?: string; indexable: boolean };
  chrome: unknown;
  presentation: unknown;
}>;

export type JapaneseSidecar = Readonly<{
  releaseId: string;
  locale: "ja";
  sidecarId: "experience-detail" | "booking" | "chrome";
  kind: "template" | "shared";
  sourcePath?: string;
  document: unknown;
  presentation: unknown;
}>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
};
async function publicJson(path: string): Promise<unknown | null> {
  let response: Response;
  try {
    const origin = new URL(config.nihoWebOrigin);
    if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("invalid origin");
    response = await fetch(new URL(path, origin), { method: "GET", headers: { Accept: "application/json" }, cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(4_000) });
  } catch { return null; }
  if (response.status === 404) return null;
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new JapaneseReleaseUnavailable("invalid");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 768 * 1024) throw new JapaneseReleaseUnavailable("invalid");
  try { return await readBoundedJson(response, 768 * 1024); }
  catch { throw new JapaneseReleaseUnavailable("invalid"); }
}

/**
 * Where the Japanese interface comes from (#59). The experiences this site publishes (`EXPERIENCE_PUBLICATIONS_ENABLED`
 * in http mode) are Japanese from their own confirmed manuscripts, so their copy and static pages are this repository's
 * (ja-static-copy.ts) and nothing is read from NIHO. Otherwise (the NIHO catalogue of the preview and the former sale) the
 * release NIHO serves is used as before.
 */
export function localJapaneseRelease(): boolean {
  return config.apiMode === "http" && config.experiencePublicationsEnabled;
}

/** Route and search-engine data of the four static pages in the local release. Help is not indexed, as in English. */
const LOCAL_STATIC_PAGES = {
  home: { titleKey: "meta.siteTitle", descriptionKey: "meta.description", indexable: true },
  experiences: { titleKey: "catalogue.metaTitle", descriptionKey: "catalogue.metaDescription", indexable: true },
  host: { titleKey: "host.metaTitle", descriptionKey: "host.metaDescription", indexable: true },
  help: { titleKey: "help.metaTitle", descriptionKey: null, indexable: false },
} as const;

function localJapanesePage(pageId: keyof typeof LOCAL_STATIC_PAGES): JapanesePage {
  const { values } = localJapaneseCopy();
  const page = LOCAL_STATIC_PAGES[pageId];
  const sourcePath = STATIC_SOURCE_PATHS[pageId];
  return {
    releaseId: LOCAL_JAPANESE_RELEASE_ID,
    locale: "ja",
    document: null,
    route: { pageId, sourcePath, path: sourcePath === "/" ? "/ja" : `/ja${sourcePath}`, indexable: page.indexable },
    seo: { pageId, title: values[page.titleKey], ...(page.descriptionKey ? { description: values[page.descriptionKey] } : {}), indexable: page.indexable },
    chrome: null,
    presentation: null,
  };
}

const STATIC_SOURCE_PATHS = {
  home: "/",
  experiences: "/experiences",
  host: "/host",
  help: "/help",
} as const satisfies Partial<Record<PageId, string>>;

function parseRoute(value: unknown, pageId: PageId): JapanesePage["route"] {
  if (!isObject(value) || !exactKeys(value, ["pageId", "sourcePath", "path", "indexable"]) || value.pageId !== pageId || typeof value.sourcePath !== "string" || typeof value.path !== "string" || typeof value.indexable !== "boolean") throw new Error("Invalid localized route");
  const sourcePath = STATIC_SOURCE_PATHS[pageId as keyof typeof STATIC_SOURCE_PATHS];
  if (!sourcePath || value.sourcePath !== sourcePath) throw new Error("Localized source path mismatch");
  // The producer publishes the Japanese root as /ja/. Next serves its canonical route at
  // /ja, so retain the producer validation while returning the non-redirecting URL.
  const publishedPath = sourcePath === "/" ? "/ja/" : `/ja${sourcePath}`;
  if (value.path !== publishedPath) throw new Error("Localized route mismatch");
  return { pageId, sourcePath, path: sourcePath === "/" ? "/ja" : publishedPath, indexable: value.indexable };
}

function parseSeo(value: unknown, pageId: PageId): JapanesePage["seo"] {
  if (!isObject(value) || !exactKeys(value, ["pageId", "title", "indexable"], ["description"]) || value.pageId !== pageId || typeof value.title !== "string" || typeof value.indexable !== "boolean" || (value.description !== undefined && typeof value.description !== "string")) throw new Error("Invalid localized SEO");
  return value as JapanesePage["seo"];
}

const STATIC_PAGE_IDS = new Set<PageId>(["home", "experiences", "host", "help"]);
export const getJapanesePage = cache(async (pageId: PageId): Promise<JapanesePage> => {
  if (!config.japaneseSiteEnabled) throw new JapaneseReleaseUnavailable("disabled");
  if (!STATIC_PAGE_IDS.has(pageId)) throw new JapaneseReleaseUnavailable("invalid");
  if (localJapaneseRelease()) return localJapanesePage(pageId as keyof typeof LOCAL_STATIC_PAGES);
  const value = await publicJson(`/api/public/experiences/pages/localized/${encodeURIComponent(pageId)}/ja`);
  if (!isObject(value)) throw new JapaneseReleaseUnavailable("missing");
  try {
    if (typeof value.releaseId !== "string" || !value.releaseId || value.locale !== "ja") throw new Error("Invalid localized page");
    const display = isObject(value.display) ? value.display : null;
    return { releaseId: value.releaseId, locale: "ja", document: value.document, route: parseRoute(value.route, pageId), seo: parseSeo(value.seo, pageId), chrome: display?.chrome, presentation: value.presentation };
  } catch (error) {
    if (error instanceof JapaneseReleaseUnavailable) throw error;
    throw new JapaneseReleaseUnavailable("invalid");
  }
});

export const getJapaneseSidecar = cache(async (sidecarId: JapaneseSidecar["sidecarId"]): Promise<JapaneseSidecar> => {
  if (!config.japaneseSiteEnabled) throw new JapaneseReleaseUnavailable("disabled");
  const value = await publicJson(`/api/public/experiences/pages/localized/sidecars/${encodeURIComponent(sidecarId)}/ja`);
  if (!isObject(value)) throw new JapaneseReleaseUnavailable("missing");
  try {
    if (typeof value.releaseId !== "string" || !value.releaseId || value.locale !== "ja" || value.sidecarId !== sidecarId || !["template", "shared"].includes(String(value.kind)) || !("document" in value)) throw new Error("Invalid localized sidecar");
    return { releaseId: value.releaseId, locale: "ja", sidecarId, kind: value.kind as JapaneseSidecar["kind"], ...(typeof value.sourcePath === "string" ? { sourcePath: value.sourcePath } : {}), document: value.document, presentation: value.presentation };
  } catch { throw new JapaneseReleaseUnavailable("invalid"); }
});

export const getJapaneseCopy = cache(async (): Promise<{ releaseId: string; values: StaticCopyValuesV1; copy: StaticCopyAccessorV1 }> => {
  if (!config.japaneseSiteEnabled) throw new JapaneseReleaseUnavailable("disabled");
  if (localJapaneseRelease()) {
    const copy = localJapaneseCopy();
    return { releaseId: LOCAL_JAPANESE_RELEASE_ID, values: copy.values, copy };
  }
  const result = await (await getApi()).getJapaneseSiteCopy();
  if (!result.ok) throw new JapaneseReleaseUnavailable(result.kind === "not_found" ? "missing" : "invalid");
  try {
    const response: ExperienceInterfaceCopyResponse = result.data;
    const copy = createStaticCopyV1(response.values as StaticCopyValuesV1);
    return { releaseId: response.releaseId, values: copy.values, copy };
  } catch { throw new JapaneseReleaseUnavailable("invalid"); }
});

export const getJapaneseCatalog = cache(async (): Promise<SelectedExperienceCatalogResponse> => {
  if (!config.japaneseSiteEnabled) throw new JapaneseReleaseUnavailable("disabled");
  const [copy, result] = await Promise.all([getJapaneseCopy(), getApi().then((api) => api.listJapaneseExperiences({ region: "kamakura" }))]);
  if (!result.ok) throw new JapaneseReleaseUnavailable(result.kind === "not_found" ? "missing" : "invalid");
  if (result.data.releaseId !== copy.releaseId || result.data.copySchemaVersion !== 2) throw new JapaneseReleaseUnavailable("mismatch");
  return result.data;
});

export const getJapaneseDetail = cache(async (slug: string): Promise<SelectedExperienceDetailResponse> => {
  if (!config.japaneseSiteEnabled) throw new JapaneseReleaseUnavailable("disabled");
  const [copy, catalog, result] = await Promise.all([getJapaneseCopy(), getJapaneseCatalog(), getApi().then((api) => api.getJapaneseExperience(slug))]);
  if (!result.ok) throw new JapaneseReleaseUnavailable(result.kind === "not_found" ? "missing" : "invalid");
  if (result.data.releaseId !== copy.releaseId || result.data.releaseId !== catalog.releaseId || result.data.copySchemaVersion !== 2 || !catalog.experiences.some((item) => item.slug === result.data.experience.slug && item.slug === slug)) throw new JapaneseReleaseUnavailable("mismatch");
  return result.data;
});

export const getPreparedJapaneseStaticRelease = cache(async () => {
  if (!config.japaneseSiteEnabled) throw new JapaneseReleaseUnavailable("disabled");
  const [copy, catalog, ...pages] = await Promise.all([
    getJapaneseCopy(),
    // Optional: without this release's catalog the static pages still render, only with no experience pairs.
    config.apiMode === "http" ? Promise.resolve(null) : getJapaneseCatalog().catch(() => null),
    getJapanesePage("home"),
    getJapanesePage("experiences"),
    getJapanesePage("host"),
    getJapanesePage("help"),
  ]);
  assertSameJapaneseRelease(copy.releaseId, ...pages);
  const pageById = Object.freeze(Object.fromEntries(pages.map((page) => [page.route.pageId, page])) as Readonly<Record<keyof typeof STATIC_SOURCE_PATHS, JapanesePage>>);
  const nativeCatalog = config.apiMode === "http"
    ? await import("./experience/site-publications").then((source) => source.listSitePublicExperiences()).catch(() => null)
    : null;
  const experiences = config.apiMode === "http"
    ? mapPublicationJapaneseExperiences(nativeCatalog?.experiences ?? [], config.bookingsEnabled && config.guestBookingEnabled)
    : mapJapaneseExperiences(copy.releaseId, catalog);
  const counterparts = Object.freeze({ ...Object.fromEntries(pages.map((page) => [page.route.sourcePath, page.route.path])), ...experienceCounterparts(experiences) });
  return Object.freeze({ releaseId: copy.releaseId, copy, pages: Object.freeze(pages), pageById, experiences, counterparts });
});

/** Language-switch table: the four static pages and the experience pages paired in the same release (localized-mapping.ts). */
export const getJapaneseStaticCounterparts = cache(async (): Promise<Readonly<Record<string, string>>> => {
  return (await getPreparedJapaneseStaticRelease()).counterparts;
});
