/** The only image reference that an editable guide may save or publish. */
export const GUIDE_ASSET_URI_PREFIX = "niho-guide-asset:";
export const GUIDE_ASSET_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ESCAPABLE_PUNCTUATION = /[!-/:-@[-`{-~]/;
const HTML_ENTITY = /^&#?[A-Za-z0-9]+;/;

/**
 * Parses a complete, canonical internal figure line. Its alt rules deliberately
 * match the guide Markdown plain-text subset, so the Store and Web cannot
 * disagree about whether a published figure will render.
 */
export function parseGuideAssetFigureLine(line: string): { assetId: string; alt: string } | null {
  if (!line.startsWith("![")) return null;
  let alt = "";
  for (let index = 2; index < line.length; index++) {
    const char = line[index]!;
    const next = line[index + 1] ?? "";
    if (char === "\\") {
      if (!next || !ESCAPABLE_PUNCTUATION.test(next)) return null;
      alt += next;
      index++;
      continue;
    }
    if (char === "]") {
      const target = line.slice(index + 1);
      const prefix = `(${GUIDE_ASSET_URI_PREFIX}`;
      if (!target.startsWith(prefix) || !target.endsWith(")")) return null;
      const assetId = target.slice(prefix.length, -1);
      const trimmedAlt = alt.trim();
      return GUIDE_ASSET_UUID_V4.test(assetId) && trimmedAlt.length > 0 && trimmedAlt.length <= 300
        ? { assetId, alt: trimmedAlt }
        : null;
    }
    if (
      char === "[" || char === "`" || char === "_" || char === "*"
      || (char === "<" && /[A-Za-z/!?]/.test(next))
      || (char === "&" && HTML_ENTITY.test(line.slice(index)))
      || (char === "~" && next === "~")
    ) return null;
    alt += char;
  }
  return null;
}
