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
    readonly publicCredit: string | null;
  }[];
  readonly publishedAtUtc: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

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

function projectPhotos(value: unknown): PublicExperiencePublication["photos"] | null {
  if (!Array.isArray(value)) return null;
  const photos: { src: string; alt: string; publicCredit: string | null }[] = [];
  for (const rawPhoto of value) {
    const photo = record(rawPhoto);
    if (!photo || typeof photo.asset_id !== "string" || !/^[0-9a-f-]{36}$/i.test(photo.asset_id)) return null;
    const alt = text(photo.alt_text);
    const publicCredit = nullableText(photo.public_credit);
    if (alt === null || publicCredit === undefined) return null;
    photos.push({ src: `/api/public/experience-media/${encodeURIComponent(photo.asset_id)}`, alt, publicCredit });
  }
  return photos;
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
  const manuscript = projectPublicExperiencePublicationManuscript(row.content);
  const currency = typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
  const unitAmount = safeInteger(row.unit_amount);
  const sellerDisplayName = text(row.seller_display_name, false);
  const photos = projectPhotos(row.photos);
  const publishedAtUtc = instant(row.published_at);
  if (slug === null || publicTitle === null || manuscript === null || currency === null || unitAmount === null
      || sellerDisplayName === null || photos === null || publishedAtUtc === null) return null;
  return { slug, publicTitle, ...manuscript, currency, unitAmount, sellerDisplayName, photos, publishedAtUtc };
}
