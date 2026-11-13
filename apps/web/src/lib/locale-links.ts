const EXPERIENCE_PATH = /^\/experiences(?:\/[^/?#]+(?:\/book)?)?$/;

/** Routes owned by the public bilingual site. Everything else stays on its authoritative route. */
export function isSupportedPublicPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/host" || pathname === "/help" || pathname === "/booking/return" || EXPERIENCE_PATH.test(pathname);
}

function switchQuery(sourcePath: string, query: string): string {
  const allowed = sourcePath === "/experiences"
    ? new Set(["q", "theme", "date", "guests"])
    : /^\/experiences\/[^/]+(?:\/book)?$/.test(sourcePath)
      ? new Set(["q", "theme", "date", "guests", "offer"])
      : new Set<string>();
  const filtered = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(query)) if (allowed.has(key)) filtered.append(key, value);
  return filtered.toString();
}

export function languageSwitchTarget(pathname: string, query: string, counterparts: Readonly<Record<string, string>>): string | null {
  const sourcePath = pathname === "/ja" || pathname === "/ja/" ? "/" : pathname.startsWith("/ja/") ? pathname.slice(3) : pathname;
  const japanesePath = counterparts[sourcePath];
  if (!japanesePath) return null;
  const isEnglish = pathname === sourcePath;
  const filtered = switchQuery(sourcePath, query);
  return `${isEnglish ? japanesePath : sourcePath}${filtered ? `?${filtered}` : ""}`;
}

/**
 * A counterpart of "" says the page has no page in the other language and the button is not shown (a Japanese-only
 * experience, #59). A path with no entry at all has no pair, and the button goes to the other language's top page (#562).
 */
export const NO_LANGUAGE_COUNTERPART = "";

/** Where the header's language button leads from this page, or null when it is not shown. */
export function languageButtonTarget(pathname: string, query: string, counterparts: Readonly<Record<string, string>>): string | null {
  const isJapanese = pathname === "/ja" || pathname.startsWith("/ja/");
  const sourcePath = pathname === "/ja" || pathname === "/ja/" ? "/" : isJapanese ? pathname.slice(3) : pathname;
  if (counterparts[sourcePath] === NO_LANGUAGE_COUNTERPART) return null;
  return languageSwitchTarget(pathname, query, counterparts) ?? (isJapanese ? "/" : "/ja");
}
