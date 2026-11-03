import type { Guide } from "@/content/guides";

/** Editor preview has no current writer/link binding, so it must never present related experiences as authorized. */
export function withoutUnverifiedPreviewRelated(guide: Guide, editorPreview: boolean): Guide {
  return editorPreview && guide.relatedExperienceSlugs.length > 0 ? { ...guide, relatedExperienceSlugs: [] } : guide;
}
