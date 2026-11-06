"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createStaticCopyV1,
  defaultStaticCopyValuesV1,
  type StaticCopyAccessorV1,
  type StaticCopyValuesV1,
} from "@niho/experience-presentation/v1";
import type { SiteLocale } from "@/lib/localized-content";
import { isSupportedPublicPath } from "@/lib/locale-links";
import { createJapaneseCopy } from "@/lib/ja-copy";

type SiteLocaleValue = Readonly<{
  locale: SiteLocale;
  releaseId: string | null;
  prefix: "" | "/ja";
  copy: StaticCopyAccessorV1;
}>;

const defaultValue: SiteLocaleValue = {
  locale: "en",
  releaseId: null,
  prefix: "",
  copy: createStaticCopyV1(defaultStaticCopyValuesV1()),
};

const SiteLocaleContext = createContext<SiteLocaleValue>(defaultValue);

export function SiteLocaleProvider({ locale, releaseId = null, values, children }: {
  locale: SiteLocale;
  releaseId?: string | null;
  values?: StaticCopyValuesV1;
  children: ReactNode;
}) {
  const value = useMemo<SiteLocaleValue>(() => ({ locale, releaseId, prefix: locale === "ja" ? "/ja" : "", copy: locale === "ja" ? createJapaneseCopy(values ?? defaultStaticCopyValuesV1()) : createStaticCopyV1(values ?? defaultStaticCopyValuesV1()) }), [locale, releaseId, values]);
  return <SiteLocaleContext.Provider value={value}>{children}</SiteLocaleContext.Provider>;
}

export const useSiteLocale = () => useContext(SiteLocaleContext);
export const useSiteCopy = () => useSiteLocale().copy;

/** Only same-origin public-site paths are locale-prefixed. Host console and API paths stay authoritative. */
export function localeHref(href: string, locale: SiteLocale): string {
  if (locale !== "ja" || !href.startsWith("/") || href.startsWith("//")) return href;
  if (href === "/ja" || href.startsWith("/ja/")) return href;
  const boundary = href.search(/[?#]/);
  const pathname = boundary === -1 ? href : href.slice(0, boundary);
  if (!isSupportedPublicPath(pathname)) return href;
  return pathname === "/" ? `/ja${href.slice(1)}` : `/ja${href}`;
}
