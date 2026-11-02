/**
 * 体験ページ・集合場所・掲載・写真の応答を確かめて取り出す読み手（`client.ts` から使う）。応答は信頼境界の外なので、
 * 契約に書かれた項目だけを、型・列挙・null の許可を確かめてから写す（知らない項目は渡さない）。
 * 長さ・範囲は確かめない（NIHO が書き込み時に検証する。画面は表示の側で丸める）。署名つき URL は https だけを受け取る。
 */
import {
  EXPERIENCE_PROVIDER_PAGE_PUBLISH_BLOCKERS,
  type ExperienceProviderMeetingPoint,
  type ExperienceProviderMeetingPointResponse,
  type ExperienceProviderPageAcceptanceMode,
  type ExperienceProviderPageBookingQuestionInputType,
  type ExperienceProviderPageCancellationPolicy,
  type ExperienceProviderPageContent,
  type ExperienceProviderPageDeleteResponse,
  type ExperienceProviderPageDetail,
  type ExperienceProviderPageKind,
  type ExperienceProviderPageLanguage,
  type ExperienceProviderPageListingResponse,
  type ExperienceProviderPageListResponse,
  type ExperienceProviderPageMeetingPointMode,
  type ExperienceProviderPageMeetingPointResponse,
  type ExperienceProviderPageMeetingPointUpdateResponse,
  type ExperienceProviderPagePreviewOccurrence,
  type ExperienceProviderPagePreviewResponse,
  type ExperienceProviderPagePreviewSpot,
  type ExperienceProviderPageStatus,
  type ExperienceProviderUploadPolicyResponse,
  type ExperienceProviderUploadSignedUrlResponse,
  type ExperienceSiteListingStatus,
} from "./types.ts";

/** 読めなかった印（null は契約の値として使うので、失敗は別の値で表す）。 */
const INVALID: unique symbol = Symbol("invalid");
type Reader<T> = (value: unknown) => T | typeof INVALID;
type ReaderShape = Record<string, Reader<unknown>>;
type ShapeOf<S extends ReaderShape> = { [K in keyof S]: S[K] extends Reader<infer T> ? T : never };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const string: Reader<string> = (value) => (typeof value === "string" ? value : INVALID);
const boolean: Reader<boolean> = (value) => (typeof value === "boolean" ? value : INVALID);
const integer: Reader<number> = (value) => (typeof value === "number" && Number.isInteger(value) ? value : INVALID);

/** 署名つき URL（https・ユーザー名とパスワードを含まない）。 */
const httpsUrl: Reader<string> = (value) => {
  if (typeof value !== "string") return INVALID;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : INVALID;
  } catch {
    return INVALID;
  }
};

/** 集合場所の地図の URL（空文字か https）。 */
const mapUrl: Reader<string> = (value) => (value === "" ? value : httpsUrl(value));

function oneOf<T extends string | boolean | null>(values: readonly T[]): Reader<T> {
  return (value) => ((values as readonly unknown[]).includes(value) ? (value as T) : INVALID);
}

function nullable<T>(read: Reader<T>): Reader<T | null> {
  return (value) => (value === null ? null : read(value));
}

/** 新しいnullable項目を追加した契約の段階配備中、旧応答の未送信をnullとして読む。 */
function nullableWhenMissing<T>(read: Reader<T>): Reader<T | null> {
  return (value) => (value === undefined || value === null ? null : read(value));
}

function arrayOf<T>(read: Reader<T>): Reader<T[]> {
  return (value) => {
    if (!Array.isArray(value)) return INVALID;
    const items: T[] = [];
    for (const item of value) {
      const parsed = read(item);
      if (parsed === INVALID) return INVALID;
      items.push(parsed);
    }
    return items;
  };
}

/** 閉じた object：shape に書いた項目だけを写す（どれか 1 つでも読めなければ失敗）。 */
function object<S extends ReaderShape>(shape: S): Reader<ShapeOf<S>> {
  return (value) => {
    if (!isObject(value)) return INVALID;
    const result: JsonObject = {};
    for (const [key, read] of Object.entries(shape)) {
      const parsed = read(value[key]);
      if (parsed === INVALID) return INVALID;
      result[key] = parsed;
    }
    return result as ShapeOf<S>;
  };
}

/** 値が文字列だけの map（写真の署名つき POST の form の項目）。名前は GCS が決めるので開いている。 */
const stringMap: Reader<Record<string, string>> = (value) => {
  if (!isObject(value)) return INVALID;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return INVALID;
    result[key] = item;
  }
  return result;
};

/** client の `call` が使う形（読めなければ null）。 */
function toBodyReader<T>(read: Reader<T>): (body: unknown) => T | null {
  return (body) => {
    const parsed = read(body);
    return parsed === INVALID ? null : parsed;
  };
}

const PAGE_KINDS: readonly ExperienceProviderPageKind[] = ["EXPERIENCE"];
const PAGE_LANGUAGES: readonly ExperienceProviderPageLanguage[] = ["EN", "JA"];
const PAGE_STATUSES: readonly ExperienceProviderPageStatus[] = ["DRAFT", "PUBLISHED", "UNPUBLISHED"];
const CANCELLATION_POLICIES: readonly ExperienceProviderPageCancellationPolicy[] = ["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"];
const ACCEPTANCE_MODES: readonly ExperienceProviderPageAcceptanceMode[] = ["INSTANT", "APPROVAL"];
const QUESTION_INPUT_TYPES: readonly ExperienceProviderPageBookingQuestionInputType[] = ["SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT"];
const MEETING_POINT_MODES: readonly ExperienceProviderPageMeetingPointMode[] = ["INHERIT", "OVERRIDE"];
const LISTING_STATUSES: readonly ExperienceSiteListingStatus[] = ["REQUESTED", "ACTIVE", "PAUSED", "WITHDRAWN"];
const SPACE_SCOPES = ["ENTIRE_FACILITY", "DESIGNATED_AREA"] as const;
const OCCURRENCE_UNAVAILABLE_REASONS = ["cutoff", "full", "unavailable"] as const;
const LANDING_GROUNDS: readonly ExperienceProviderPagePreviewSpot["landingGround"][] = ["LIGHT", "DARK_WARM"];
const LANDING_ACCENTS: readonly ExperienceProviderPagePreviewSpot["landingAccent"][] = ["LEAF", "CORAL", "TERRACOTTA", "SAND", "SUMI"];
const LANDING_FONTS: readonly ExperienceProviderPagePreviewSpot["landingFont"][] = ["MARU", "KAKU", "MINCHO", "KYOKASHO", "MODERN", "CLASSIC"];
const PARTICIPATION_ACTIVITIES = ["FLOOR_SITTING", "LONG_STANDING", "WALKING", "UNEVEN_GROUND"] as const;
const PARTICIPATION_DIETARY_OPTIONS = ["VEGETARIAN", "VEGAN", "HALAL", "GLUTEN_FREE", "NO_PORK", "NO_ALCOHOL"] as const;
const PARTICIPATION_LANGUAGE_LEVELS = ["FLUENT", "CONVERSATIONAL", "BASIC"] as const;
const PARTICIPATION_WHEELCHAIR_ACCESS = ["ACCESSIBLE", "PARTIAL", "NOT_ACCESSIBLE"] as const;
const PARTICIPATION_WEATHER_POLICIES = ["RAIN_OR_SHINE", "ADJUSTED_FOR_RAIN", "MAY_CANCEL"] as const;

type ParticipationConditions = ExperienceProviderPageContent["participationConditions"];
const EMPTY_PARTICIPATION_CONDITIONS: ParticipationConditions = {
  age: null,
  physical: null,
  hostLanguages: null,
  food: null,
  accessibility: null,
  weather: null,
};
const participationConditions: Reader<ParticipationConditions> = (value) => {
  // v0.3 API responses predate this field; treat omission (and legacy null) as no conditions.
  if (value === undefined || value === null) return { ...EMPTY_PARTICIPATION_CONDITIONS };
  return object({
    age: nullable(object({ minimumAge: nullable(integer), childrenWithAdult: boolean, note: string })),
    physical: nullable(object({ activities: arrayOf(oneOf(PARTICIPATION_ACTIVITIES)), note: string })),
    hostLanguages: nullable(object({ japanese: nullable(oneOf(PARTICIPATION_LANGUAGE_LEVELS)), english: nullable(oneOf(PARTICIPATION_LANGUAGE_LEVELS)), note: string })),
    food: nullable(object({ provided: boolean, dietaryOptions: arrayOf(oneOf(PARTICIPATION_DIETARY_OPTIONS)), note: string })),
    accessibility: nullable(object({ wheelchair: oneOf(PARTICIPATION_WHEELCHAIR_ACCESS), note: string })),
    weather: nullable(object({ policy: oneOf(PARTICIPATION_WEATHER_POLICIES), note: string })),
  })(value);
};

// 集合場所

const meetingPoint: Reader<ExperienceProviderMeetingPoint> = object({
  overview: string,
  address: string,
  accessNote: string,
  mapUrl,
  entranceNote: string,
});

const meetingPointResponse: Reader<ExperienceProviderMeetingPointResponse> = object({ meetingPoint });

const pageMeetingPointResponse: Reader<ExperienceProviderPageMeetingPointResponse> = object({ mode: oneOf(MEETING_POINT_MODES), meetingPoint });

const pageMeetingPointUpdateResponse: Reader<ExperienceProviderPageMeetingPointUpdateResponse> = (value) => {
  if (!isObject(value)) return INVALID;
  if (value.mode === "INHERIT") return object({ mode: oneOf(["INHERIT"] as const), updatedAt: string })(value);
  if (value.mode === "OVERRIDE") return object({ mode: oneOf(["OVERRIDE"] as const), updatedAt: string, meetingPoint })(value);
  return INVALID;
};

// 体験ページ

const pageListResponse: Reader<ExperienceProviderPageListResponse> = object({
  checkoutEnabled: boolean,
  pages: arrayOf(
    object({
      id: string,
      kind: oneOf(PAGE_KINDS),
      slug: string,
      language: oneOf(PAGE_LANGUAGES),
      title: string,
      coverUrl: nullable(httpsUrl),
      status: oneOf(PAGE_STATUSES),
      listOnEntrance: boolean,
      bookingCounts: object({ confirmed: integer, thisWeek: integer }),
      updatedAt: string,
    }),
  ),
});

const bookingQuestion = object({
  id: string,
  prompt: string,
  description: nullable(string),
  inputType: oneOf(QUESTION_INPUT_TYPES),
  required: boolean,
  options: arrayOf(object({ id: string, label: string })),
});

const offer = object({
  id: string,
  name: string,
  shortDescription: nullable(string),
  sortOrder: integer,
  isActive: boolean,
  priceYen: integer,
  childPriceYen: nullable(integer),
  childMinAge: nullable(integer),
  childMaxAge: nullable(integer),
  adultRequiredForChild: boolean,
  capacity: integer,
  maxPartySize: integer,
  minimumParticipants: integer,
  weekdays: arrayOf(integer),
  startTime: string,
  durationMinutes: integer,
  cutoffDays: integer,
  closedDates: arrayOf(string),
  cancellationPolicy: oneOf(CANCELLATION_POLICIES),
  acceptanceMode: oneOf(ACCEPTANCE_MODES),
  spaceScope: oneOf(SPACE_SCOPES),
  useZone: arrayOf(string),
  bookingQuestions: arrayOf(bookingQuestion),
});

const pageContent = object({
  lead: string,
  facts: object({ language: string }),
  highlights: arrayOf(string),
  timeline: arrayOf(object({ time: string, title: string, text: string, photoObjectKey: nullable(string) })),
  description: string,
  included: arrayOf(string),
  notIncluded: arrayOf(string),
  notSuitableFor: arrayOf(string),
  meetingPoint: object({ entranceNote: string, exteriorPhotoObjectKey: nullable(string) }),
  knowBeforeYouGo: arrayOf(string),
  hostUserIds: arrayOf(string),
  participationConditions,
});

const pageDetail: Reader<ExperienceProviderPageDetail> = object({
  id: string,
  kind: oneOf(PAGE_KINDS),
  slug: string,
  language: oneOf(PAGE_LANGUAGES),
  title: string,
  status: oneOf(PAGE_STATUSES),
  listOnEntrance: boolean,
  publishedAt: nullable(string),
  unpublishedAt: nullable(string),
  content: pageContent,
  photos: arrayOf(object({ objectKey: string, url: nullable(httpsUrl) })),
  coverObjectKey: nullable(string),
  offer: nullable(offer),
  offers: arrayOf(offer),
  publishBlockers: arrayOf(oneOf(EXPERIENCE_PROVIDER_PAGE_PUBLISH_BLOCKERS)),
  publicPath: string,
  createdAt: string,
  updatedAt: string,
  photoAlts: arrayOf(string),
});

const pageDeleteResponse: Reader<ExperienceProviderPageDeleteResponse> = object({ id: string, deleted: oneOf([true] as const) });

// プレビュー

const previewOccurrence: Reader<ExperienceProviderPagePreviewOccurrence> = (value) => {
  if (!isObject(value)) return INVALID;
  const common = { date: string, startAt: string, endAt: string, seatsLeft: integer };
  if (value.bookable === true) return object({ ...common, bookable: oneOf([true] as const) })(value);
  if (value.bookable === false) return object({ ...common, bookable: oneOf([false] as const), reason: oneOf(OCCURRENCE_UNAVAILABLE_REASONS) })(value);
  return INVALID;
};

const previewOfferSummaryShape = {
  id: string,
  name: string,
  shortDescription: nullable(string),
  sortOrder: integer,
  priceYen: integer,
  childPriceYen: nullable(integer),
  childMinAge: nullable(integer),
  childMaxAge: nullable(integer),
  adultRequiredForChild: boolean,
  currency: oneOf(["JPY"] as const),
  capacity: integer,
  maxPartySize: integer,
  minimumParticipants: integer,
  durationMinutes: integer,
  startTime: string,
  cancellationPolicy: oneOf(CANCELLATION_POLICIES),
  acceptanceMode: oneOf(ACCEPTANCE_MODES),
  bookingQuestions: arrayOf(bookingQuestion),
  bookingQuestionsFingerprint: string,
};

const previewTimelineItem = object({
  time: string,
  title: string,
  titleEn: nullable(string),
  text: string,
  textEn: nullable(string),
  photoIndex: nullable(integer),
});

const previewContent = object({
  lead: string,
  leadEn: nullable(string),
  facts: object({ language: string, languageEn: nullable(string) }),
  highlights: arrayOf(string),
  highlightsEn: arrayOf(nullable(string)),
  timeline: arrayOf(previewTimelineItem),
  description: string,
  descriptionEn: nullable(string),
  included: arrayOf(string),
  includedEn: arrayOf(nullable(string)),
  notIncluded: arrayOf(string),
  notIncludedEn: arrayOf(nullable(string)),
  notSuitableFor: arrayOf(string),
  notSuitableForEn: arrayOf(nullable(string)),
  knowBeforeYouGo: arrayOf(string),
  knowBeforeYouGoEn: arrayOf(nullable(string)),
});

const pagePreview: Reader<ExperienceProviderPagePreviewResponse> = object({
  page: object({
    slug: string,
    kind: oneOf(PAGE_KINDS),
    language: oneOf(PAGE_LANGUAGES),
    title: string,
    titleEn: nullable(string),
    content: previewContent,
    photos: arrayOf(object({ url: httpsUrl })),
    coverUrl: nullable(httpsUrl),
  }),
  spot: object({
    slug: string,
    name: string,
    logoUrl: nullable(string),
    tagline: nullable(string),
    taglineEn: nullable(string),
    landingGround: oneOf(LANDING_GROUNDS),
    landingAccent: oneOf(LANDING_ACCENTS),
    landingFont: oneOf(LANDING_FONTS),
    // 提供者の器は住所を載せないので常に null
    meetingPoint: oneOf([null] as const),
  }),
  // avatarUrl は NIHO の proxy の path（/api/media/avatar…）で、https の URL とは限らない
  hosts: arrayOf(object({ displayName: string, avatarUrl: nullable(string) })),
  offers: arrayOf(object({ ...previewOfferSummaryShape, occurrences: arrayOf(previewOccurrence) })),
  offer: object(previewOfferSummaryShape),
  occurrences: arrayOf(previewOccurrence),
});

// 掲載

const pageListingResponse: Reader<ExperienceProviderPageListingResponse> = object({
  listing: nullable(
    object({
      id: string,
      spotId: string,
      campaignPageId: string,
      status: oneOf(LISTING_STATUSES),
      slug: nullable(string),
      regionKey: nullable(string),
      consentVersion: string,
      consentedAt: string,
      approvedAt: nullable(string),
      pausedAt: nullable(string),
      withdrawnAt: nullable(string),
      // Host contract v0.3 did not send these fields. Keep reading that deployed response until v0.4 is deployed.
      reviewNote: nullableWhenMissing(string),
      reviewNotedAt: nullableWhenMissing(string),
      createdAt: string,
      updatedAt: string,
    }),
  ),
  consent: object({ version: string, text: string }),
});

// 写真

const uploadPolicy: Reader<ExperienceProviderUploadPolicyResponse> = object({
  uploadId: string,
  objectKey: string,
  upload: object({ url: httpsUrl, fields: stringMap }),
  expiresAt: string,
  maxSizeBytes: integer,
});

const uploadSignedUrl: Reader<ExperienceProviderUploadSignedUrlResponse> = object({ objectKey: string, signedUrl: httpsUrl, expiresAt: string });

export const readMeetingPointResponse = toBodyReader(meetingPointResponse);
export const readPageMeetingPointResponse = toBodyReader(pageMeetingPointResponse);
export const readPageMeetingPointUpdateResponse = toBodyReader(pageMeetingPointUpdateResponse);
export const readPageListResponse = toBodyReader(pageListResponse);
export const readPageDetail = toBodyReader(pageDetail);
export const readPageDeleteResponse = toBodyReader(pageDeleteResponse);
export const readPagePreview = toBodyReader(pagePreview);
export const readPageListingResponse = toBodyReader(pageListingResponse);
export const readUploadPolicy = toBodyReader(uploadPolicy);
export const readUploadSignedUrl = toBodyReader(uploadSignedUrl);
