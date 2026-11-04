import { createHash } from "node:crypto";

export interface PublicExperiencePublicationTimelineItem {
  readonly time: string;
  readonly title: string;
  readonly text: string;
  readonly photoIndex: number | null;
}

/**
 * A deliberately narrow public copy of the host page manuscript.
 *
 * Meeting address, access, entrance instructions and map URLs belong to the
 * confirmed-booking snapshot. They are never represented by this read model.
 */
export interface PublicExperiencePublicationContent {
  readonly lead: string;
  readonly description: string;
  readonly facts: {
    readonly language: string;
  };
  readonly highlights: readonly string[];
  readonly included: readonly string[];
  readonly notIncluded: readonly string[];
  readonly knowBeforeYouGo: readonly string[];
  readonly notSuitableFor: readonly string[];
  readonly timeline: readonly PublicExperiencePublicationTimelineItem[];
}

export interface PublicExperiencePublication {
  readonly slug: string;
  readonly publicTitle: string;
  readonly content: PublicExperiencePublicationContent;
  readonly currency: string;
  readonly unitAmount: number;
  readonly sellerDisplayName: string;
  readonly meetingOverview: string | null;
  readonly meetingPointDisclosure: "PUBLIC" | "AFTER_BOOKING";
  readonly meetingPoint: {
    readonly name: string;
    readonly exteriorPhotoIndex: number | null;
  } | null;
  readonly photos: readonly {
    readonly src: string;
    readonly alt: string;
    readonly altJa: string;
    readonly publicCredit: string | null;
  }[];
  readonly providerPhoto: { readonly src: string; readonly alt: string; readonly altJa: string; readonly publicCredit: string | null } | null;
  readonly businessLogo: { readonly src: string; readonly alt: string; readonly altJa: string; readonly publicCredit: string | null } | null;
  readonly japanese: {
    readonly title: string;
    readonly lead: string;
    readonly description: string;
    readonly language: string;
    readonly highlights: readonly string[];
    readonly included: readonly string[];
    readonly notIncluded: readonly string[];
    readonly knowBeforeYouGo: readonly string[];
    readonly notSuitableFor: readonly string[];
    readonly timeline: readonly PublicExperiencePublicationTimelineItem[];
  } | null;
  readonly publishedAtUtc: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as UnknownRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const record = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;

const text = (value: unknown, allowEmpty = true): string | null =>
  typeof value === "string" && (allowEmpty || value.trim().length > 0) ? value : null;

const nullableText = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value : undefined;

const stringList = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

const photoIndex = (value: unknown): number | null | undefined =>
  value === null
    ? null
    : Number.isSafeInteger(value) && (value as number) >= 0
      ? value as number
      : undefined;

const safeInteger = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

type ProjectedMedia = {
  readonly photos: PublicExperiencePublication["photos"];
  readonly galleryPositionBySourcePosition: ReadonlyMap<number, number>;
};

function projectPhotos(value: unknown): ProjectedMedia | null {
  if (!Array.isArray(value)) return null;
  const photos: { src: string; alt: string; altJa: string; publicCredit: string | null }[] = [];
  const galleryPositionBySourcePosition = new Map<number, number>();
  for (const rawPhoto of value) {
    const photo = record(rawPhoto);
    if (!photo || typeof photo.asset_id !== "string" || !/^[0-9a-f-]{36}$/i.test(photo.asset_id)) return null;
    const alt = text(photo.alt_text);
    const altJa = text(photo.alt_text_ja);
    const publicCredit = nullableText(photo.public_credit);
    const placement = photo.placement;
    const sourcePosition = safeInteger(photo.source_position);
    if (alt === null || altJa === null || publicCredit === undefined || sourcePosition === null
      || placement !== "GALLERY") return null;
    const image = { src: `/api/public/experience-media/${encodeURIComponent(photo.asset_id)}`, alt, altJa };
    galleryPositionBySourcePosition.set(sourcePosition, photos.length);
    photos.push({ ...image, publicCredit });
  }
  return { photos, galleryPositionBySourcePosition };
}

function projectProviderMedia(value: unknown): Pick<PublicExperiencePublication, "providerPhoto" | "businessLogo"> | null {
  const rows = value === undefined || value === null ? [] : value;
  if (!Array.isArray(rows)) return null;
  let providerPhoto: PublicExperiencePublication["providerPhoto"] = null;
  let businessLogo: PublicExperiencePublication["businessLogo"] = null;
  const placements = new Set<string>();
  for (const raw of rows) {
    const media = record(raw);
    if (!media || typeof media.asset_id !== "string" || !/^[0-9a-f-]{36}$/i.test(media.asset_id)) return null;
    const alt = text(media.alt_text, false);
    const altJa = text(media.alt_text_ja, false);
    const publicCredit = nullableText(media.public_credit);
    if (alt === null || altJa === null || publicCredit === undefined) return null;
    if (media.placement !== "PROVIDER_PHOTO" && media.placement !== "BUSINESS_LOGO") return null;
    if (placements.has(media.placement)) return null;
    placements.add(media.placement);
    const image = {
      src: `/api/public/experience-provider-media/${encodeURIComponent(media.asset_id)}`,
      alt, altJa, publicCredit,
    };
    if (media.placement === "PROVIDER_PHOTO") providerPhoto = image;
    else businessLogo = image;
  }
  return { providerPhoto, businessLogo };
}

function remapPhotoReferences(
  manuscript: ProjectedManuscript,
  source: UnknownRecord,
  galleryPositionBySourcePosition: ReadonlyMap<number, number>,
): ProjectedManuscript | null {
  const mapIndex = (value: number | null): number | null | undefined => {
    if (value === null) return null;
    return galleryPositionBySourcePosition.get(value);
  };
  const timeline = manuscript.content.timeline.map((item) => {
    const photoIndex = mapIndex(item.photoIndex);
    return photoIndex === undefined ? null : { ...item, photoIndex };
  });
  if (timeline.some((item) => item === null)) return null;
  const rawMeetingPoint = record(source.meetingPoint);
  const exteriorPhotoIndex = manuscript.meetingPoint ? mapIndex(manuscript.meetingPoint.exteriorPhotoIndex) : null;
  if (exteriorPhotoIndex === undefined) return null;
  return {
    ...manuscript,
    content: { ...manuscript.content, timeline: timeline as PublicExperiencePublicationContent["timeline"] },
    meetingPoint: manuscript.meetingPoint
      ? { ...manuscript.meetingPoint, exteriorPhotoIndex }
      : rawMeetingPoint ? manuscript.meetingPoint : null,
  };
}

function projectJapaneseManuscript(
  row: UnknownRecord,
  content: UnknownRecord,
  englishTitle: string,
  galleryPositionBySourcePosition: ReadonlyMap<number, number>,
): PublicExperiencePublication["japanese"] {
  const japanese = record(content.ja);
  const translation = record(content.translation);
  if (!japanese || !translation || typeof translation.sourceFingerprint !== "string"
      || translation.confirmedSourceFingerprint !== translation.sourceFingerprint
      || typeof translation.confirmedEnglishFingerprint !== "string") return null;
  const sourceKeys = ["title", "lead", "description", "language", "highlights", "included", "notIncluded", "knowBeforeYouGo", "notSuitableFor", "timeline"];
  if (Object.keys(japanese).length !== sourceKeys.length || sourceKeys.some((key) => !Object.hasOwn(japanese, key))) return null;
  const title = text(japanese.title, false);
  const lead = text(japanese.lead, false);
  const description = text(japanese.description, false);
  const language = text(japanese.language, false);
  const highlights = stringList(japanese.highlights);
  const included = stringList(japanese.included);
  const notIncluded = stringList(japanese.notIncluded);
  const knowBeforeYouGo = stringList(japanese.knowBeforeYouGo);
  const notSuitableFor = stringList(japanese.notSuitableFor);
  const timeline = projectTimeline(japanese.timeline);
  if (!title || !lead || !description || !language || !highlights || !included || !notIncluded || !knowBeforeYouGo || !notSuitableFor || !timeline) return null;
  const sourceFingerprint = createHash("sha256").update(canonicalJson(japanese), "utf8").digest("hex");
  const englishFingerprint = createHash("sha256").update(canonicalJson({
    title: englishTitle,
    lead: content.lead,
    description: content.description,
    language: record(content.facts)?.language ?? null,
    highlights: content.highlights,
    included: content.included,
    notIncluded: content.notIncluded,
    knowBeforeYouGo: content.knowBeforeYouGo,
    notSuitableFor: content.notSuitableFor,
    timeline: content.timeline,
  }), "utf8").digest("hex");
  if (sourceFingerprint !== translation.sourceFingerprint || englishFingerprint !== translation.confirmedEnglishFingerprint) return null;
  const localizedTimeline = timeline.map((item) => {
    if (item.photoIndex === null) return item;
    const photoIndex = galleryPositionBySourcePosition.get(item.photoIndex);
    return photoIndex === undefined ? null : { ...item, photoIndex };
  });
  if (localizedTimeline.some((item) => item === null)) return null;
  return {
    title, lead, description, language, highlights, included, notIncluded, knowBeforeYouGo, notSuitableFor,
    timeline: localizedTimeline as PublicExperiencePublicationTimelineItem[],
  };
}

function projectTimeline(value: unknown): readonly PublicExperiencePublicationTimelineItem[] | null {
  if (!Array.isArray(value)) return null;
  const projected: PublicExperiencePublicationTimelineItem[] = [];
  for (const rawItem of value) {
    const item = record(rawItem);
    if (!item) return null;
    const time = text(item.time);
    const title = text(item.title);
    const itemText = text(item.text);
    const itemPhotoIndex = photoIndex(item.photoIndex);
    if (time === null || title === null || itemText === null || itemPhotoIndex === undefined) return null;
    projected.push({ time, title, text: itemText, photoIndex: itemPhotoIndex });
  }
  return projected;
}

/**
 * Projects only fields already approved by the public and host page contracts.
 * Unknown keys are intentionally discarded. A malformed approved field makes
 * the manuscript unpublishable instead of returning a partially trusted shape.
 */
export function projectPublicExperiencePublicationContent(value: unknown): PublicExperiencePublicationContent | null {
  const content = record(value);
  if (!content) return null;
  const lead = text(content.lead);
  const description = text(content.description);
  const facts = record(content.facts);
  const language = facts ? text(facts.language) : null;
  const highlights = stringList(content.highlights);
  const included = stringList(content.included);
  const notIncluded = stringList(content.notIncluded);
  const knowBeforeYouGo = stringList(content.knowBeforeYouGo);
  const notSuitableFor = stringList(content.notSuitableFor);
  const timeline = projectTimeline(content.timeline);
  if (lead === null || description === null || language === null || highlights === null || included === null
      || notIncluded === null || knowBeforeYouGo === null || notSuitableFor === null || timeline === null) return null;

  return {
    lead,
    description,
    facts: { language },
    highlights,
    included,
    notIncluded,
    knowBeforeYouGo,
    notSuitableFor,
    timeline,
  };
}

interface ProjectedManuscript {
  readonly content: PublicExperiencePublicationContent;
  readonly meetingOverview: string | null;
  readonly meetingPointDisclosure: "PUBLIC" | "AFTER_BOOKING";
  readonly meetingPoint: PublicExperiencePublication["meetingPoint"];
}

export function projectPublicExperiencePublicationManuscript(value: unknown): ProjectedManuscript | null {
  const source = record(value);
  const content = projectPublicExperiencePublicationContent(value);
  if (!source || !content) return null;
  const meetingOverview = nullableText(source.meetingOverview);
  const disclosure = source.meetingPointDisclosure;
  if (meetingOverview === undefined || (disclosure !== "PUBLIC" && disclosure !== "AFTER_BOOKING")) return null;

  let meetingPoint: PublicExperiencePublication["meetingPoint"] = null;
  if (disclosure === "PUBLIC" && source.meetingPoint !== null) {
    const rawMeetingPoint = record(source.meetingPoint);
    const name = rawMeetingPoint ? text(rawMeetingPoint.name, false) : null;
    const exteriorPhotoIndex = rawMeetingPoint ? photoIndex(rawMeetingPoint.exteriorPhotoIndex) : undefined;
    if (name === null || exteriorPhotoIndex === undefined) return null;
    meetingPoint = { name, exteriorPhotoIndex };
  }
  return { content, meetingOverview, meetingPointDisclosure: disclosure, meetingPoint };
}

const instant = (value: unknown): string | null => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** Pure public-row projection used by both PostgreSQL readers and node tests. */
export function projectPublicExperiencePublication(row: UnknownRecord): PublicExperiencePublication | null {
  const slug = text(row.slug, false);
  const publicTitle = text(row.public_title, false);
  let manuscript = projectPublicExperiencePublicationManuscript(row.content);
  const currency = typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
  const unitAmount = safeInteger(row.unit_amount);
  const sellerDisplayName = text(row.seller_display_name, false);
  const media = projectPhotos(row.photos);
  const providerMedia = projectProviderMedia(row.provider_media);
  const publishedAtUtc = instant(row.published_at);
  if (slug === null || publicTitle === null || manuscript === null || currency === null || unitAmount === null
      || sellerDisplayName === null || media === null || providerMedia === null || publishedAtUtc === null) return null;
  const source = record(row.content);
  if (!source) return null;
  manuscript = remapPhotoReferences(manuscript, source, media.galleryPositionBySourcePosition);
  if (!manuscript) return null;
  const japanese = projectJapaneseManuscript(row, source, publicTitle, media.galleryPositionBySourcePosition);
  return {
    slug, publicTitle, ...manuscript, currency, unitAmount, sellerDisplayName,
    photos: media.photos, providerPhoto: providerMedia.providerPhoto, businessLogo: providerMedia.businessLogo, japanese, publishedAtUtc,
  };
}
