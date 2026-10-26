import { safeHttpsUrl } from "../safe-url";

/**
 * A path on this site: `/guides/media/a.jpg`. Not `//host` or `/\host`, which browsers treat as another
 * site, and no spaces, backslashes or control characters.
 */
export function isSitePath(value: string): boolean {
  return /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(value);
}

/** Where a guide link may point: a site path, an in-page anchor or an https URL. Anything else is not a link (null). */
export function guideLinkHref(value: string): string | null {
  if (isSitePath(value)) return value;
  if (/^#[^\s\u0000-\u001f\u007f]+$/.test(value)) return value;
  return value.startsWith("https://") ? safeHttpsUrl(value) : null;
}

/** Hero and body photos: a site path, or (drafts only, checked separately) an https URL. */
export function guideImageSrc(value: string): string | null {
  if (isSitePath(value)) return value;
  return value.startsWith("https://") ? safeHttpsUrl(value) : null;
}

/** Published guides use only approved photos stored on this site, never the `/sample/` stand-ins. */
export function isSampleImage(src: string): boolean {
  if (!isSitePath(src)) return false;
  try {
    return new URL(src, "http://site.invalid").pathname.toLowerCase().startsWith("/sample/");
  } catch {
    return true;
  }
}
