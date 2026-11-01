/**
 * ホスト API の mock のうち、提供者の集合場所・体験ページ・体験サイトへの掲載・写真の上げ口（`mock.ts` から使う）。
 * NIHO の提供者の体験ページ API と同じ path・status・本文の形を返し、同じ契約の検証を通す。合成データだけで、
 * 写真の URL は実在しない host（`https://uploads.niho-mock.test`）を指す。状態は fetch のインスタンスの中でだけ変わる。
 */
import type {
  ExperienceHostErrorCode,
  ExperienceHostErrorReason,
  ExperienceProvider,
  ExperienceProviderMeetingPoint,
  ExperienceProviderPageBookingQuestion,
  ExperienceProviderPageContent,
  ExperienceProviderPageDetail,
  ExperienceProviderPageLanguage,
  ExperienceProviderPageListing,
  ExperienceProviderPageListingConsent,
  ExperienceProviderPageListItem,
  ExperienceProviderPageOffer,
  ExperienceProviderPagePreviewOccurrence,
  ExperienceProviderPagePreviewOfferSummary,
  ExperienceProviderPagePreviewResponse,
  ExperienceProviderPagePublishBlocker,
  ExperienceProviderPageStatus,
  ExperienceProviderPaymentReadinessReason,
} from "./types.ts";

export const MOCK_LISTING_CONSENT: ExperienceProviderPageListingConsent = {
  version: "sample-listing-consent-1",
  text: "（サンプル）この体験ページを NIHO Experience に掲載することに同意します。この文言は合成データです。",
};

/** mock の写真の URL の host（実在しない）。画面はこれを検出して手元の仮素材に置き換える。 */
const MOCK_UPLOAD_ORIGIN = "https://uploads.niho-mock.test";
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PREVIEW_DAYS = 90;
const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function isMockPhotoUrl(url: string): boolean {
  return url.startsWith(`${MOCK_UPLOAD_ORIGIN}/`);
}

export const EMPTY_MEETING_POINT: ExperienceProviderMeetingPoint = { overview: "", address: "", accessNote: "", mapUrl: "", entranceNote: "" };

export type MockPage = {
  id: string;
  slug: string;
  language: ExperienceProviderPageLanguage;
  title: string;
  status: ExperienceProviderPageStatus;
  listOnEntrance: boolean;
  publishedAt: string | null;
  unpublishedAt: string | null;
  content: ExperienceProviderPageContent;
  photoObjectKeys: string[];
  photoAlts: string[];
  offers: ExperienceProviderPageOffer[];
  /**
   * 日本語のページの鮮度確認済みの自動英訳（合成）: 日本語の原文 → 英語。今の原文と一致する項目だけが
   * プレビューの `*En` に出る。日本語を直すと原文が変わり、その項目の英語は null に戻る（作り直されるまで）。
   * 英語のページでは使わない。
   */
  englishOf: Record<string, string>;
  /** 商品ごとの確定した申込の件数。 */
  offerBookings: Record<string, number>;
  /** 確定した申込のうち、開催日が 7 日以内の件数。 */
  bookingsThisWeek: number;
  meetingPoint: { mode: "INHERIT" } | { mode: "OVERRIDE"; value: ExperienceProviderMeetingPoint };
  listing: ExperienceProviderPageListing | null;
  createdAt: string;
  updatedAt: string;
};

/** 体験ページを持つ提供者（mock.ts の MockProvider がこれを満たす）。 */
export type MockPageOwner = {
  provider: ExperienceProvider;
  /** 提供者の器の slug（公開ページの path）。 */
  vesselSlug: string;
  readiness: ExperienceProviderPaymentReadinessReason;
  meetingPoint: ExperienceProviderMeetingPoint;
  pages: MockPage[];
  /** この提供者の上げ口で上げた写真（体験ページに使える）。 */
  photos: Set<string>;
};

function iso(date: Date, offsetMs = 0): string {
  return new Date(date.getTime() + offsetMs).toISOString();
}

function photoUrl(objectKey: string, size: "w256" | "w1024"): string {
  return `${MOCK_UPLOAD_ORIGIN}/${size}/${objectKey}`;
}

function emptyContent(): ExperienceProviderPageContent {
  return {
    lead: "",
    facts: { language: "" },
    highlights: [],
    timeline: [],
    description: "",
    included: [],
    notIncluded: [],
    notSuitableFor: [],
    meetingPoint: { entranceNote: "", exteriorPhotoObjectKey: null },
    knowBeforeYouGo: [],
    hostUserIds: [],
  };
}

function defaultOffer(id: string, name: string): ExperienceProviderPageOffer {
  return {
    id,
    name,
    shortDescription: null,
    sortOrder: 0,
    isActive: true,
    priceYen: 0,
    childPriceYen: null,
    childMinAge: null,
    childMaxAge: null,
    adultRequiredForChild: false,
    capacity: 4,
    maxPartySize: 4,
    minimumParticipants: 1,
    weekdays: [],
    startTime: "10:00",
    durationMinutes: 120,
    cutoffDays: 1,
    closedDates: [],
    cancellationPolicy: "FREE_UNTIL_24H",
    acceptanceMode: "INSTANT",
    spaceScope: "ENTIRE_FACILITY",
    useZone: [],
    bookingQuestions: [],
  };
}

/** `two-providers` の OWNER の提供者（サンプルの台所）の集合場所の既定。 */
export const MOCK_KITCHEN_MEETING_POINT: ExperienceProviderMeetingPoint = {
  overview: "（サンプル）駅から歩いて 10 分ほどの住宅地",
  address: "（サンプル）サンプル市サンプル町 1 丁目（架空）",
  accessNote: "（サンプル）駅の東口を出て、川沿いを海の方へ歩きます。",
  mapUrl: "https://example.com/sample-kitchen/map",
  entranceNote: "（サンプル）木の門の呼び鈴を押してください。",
};

/** `two-providers` の OWNER の提供者の体験ページ：公開中（英語・掲載中）と下書き（日本語・公開の前提が足りない）。 */
export function seedKitchenPages(base: Date, owner: { vesselSpotId: string; vesselSlug: string }, hostUserId: string): { pages: MockPage[]; photos: string[] } {
  const photo = (name: string) => `sample-photos/${owner.vesselSlug}/${name}.jpg`;
  const photos = [photo("kitchen-table"), photo("market-basket"), photo("garden-herbs")];
  const published: MockPage = {
    id: "sample-page-kitchen-cooking",
    slug: "seasonal-home-cooking",
    language: "EN",
    title: "Cook a seasonal home meal together (sample)",
    status: "PUBLISHED",
    listOnEntrance: true,
    publishedAt: iso(base, -30 * DAY_MS),
    unpublishedAt: null,
    content: {
      lead: "A synthetic sample experience: cook and share a seasonal meal in a home kitchen.",
      facts: { language: "English / Japanese" },
      highlights: ["Pick herbs from the garden (sample)", "Learn three home-style dishes (sample)"],
      timeline: [
        { time: "10:00", title: "Welcome", text: "Tea and a short tour of the kitchen (sample).", photoObjectKey: photos[0]! },
        { time: "10:30", title: "Cook together", text: "Prepare the dishes side by side (sample).", photoObjectKey: null },
        { time: "12:00", title: "Lunch", text: "Share the meal at the big table (sample).", photoObjectKey: null },
      ],
      description: "This page is synthetic data for previews and tests. No real host, place or booking is behind it.",
      included: ["Ingredients", "Lunch", "Recipe card"],
      notIncluded: ["Transport"],
      notSuitableFor: ["Guests with severe food allergies"],
      meetingPoint: { entranceNote: "(sample) Ring the bell at the wooden gate.", exteriorPhotoObjectKey: null },
      knowBeforeYouGo: ["Wear comfortable clothes (sample)."],
      hostUserIds: [hostUserId],
    },
    photoObjectKeys: [...photos],
    photoAlts: ["The big wooden table (sample)", "A basket of vegetables (sample)", ""],
    offers: [
      {
        ...defaultOffer("sample-offer-kitchen-cooking", "Morning cooking class (sample)"),
        shortDescription: "Three dishes and lunch (sample)",
        priceYen: 8000,
        childPriceYen: 4000,
        childMinAge: 6,
        childMaxAge: 12,
        capacity: 6,
        maxPartySize: 4,
        weekdays: [2, 4, 6],
        durationMinutes: 180,
        cancellationPolicy: "FREE_UNTIL_48H",
        bookingQuestions: [
          { id: "diet", prompt: "Any dietary needs? (sample)", description: null, inputType: "SHORT_TEXT", required: false, options: [] },
        ],
      },
    ],
    englishOf: {},
    offerBookings: { "sample-offer-kitchen-cooking": 3 },
    bookingsThisWeek: 1,
    meetingPoint: { mode: "INHERIT" },
    listing: {
      id: "sample-listing-kitchen-cooking",
      spotId: owner.vesselSpotId,
      campaignPageId: "sample-page-kitchen-cooking",
      status: "ACTIVE",
      slug: "seasonal-home-cooking",
      regionKey: "kamakura",
      consentVersion: MOCK_LISTING_CONSENT.version,
      consentedAt: iso(base, -29 * DAY_MS),
      approvedAt: iso(base, -28 * DAY_MS),
      pausedAt: null,
      withdrawnAt: null,
      createdAt: iso(base, -29 * DAY_MS),
      updatedAt: iso(base, -28 * DAY_MS),
    },
    createdAt: iso(base, -32 * DAY_MS),
    updatedAt: iso(base, -2 * DAY_MS),
  };
  const draft: MockPage = {
    id: "sample-page-kitchen-market",
    slug: "morning-market-kitchen",
    language: "JA",
    title: "（サンプル）朝市で買って、台所で作る",
    status: "DRAFT",
    listOnEntrance: false,
    publishedAt: null,
    unpublishedAt: null,
    content: {
      ...emptyContent(),
      lead: "（サンプル）朝市で野菜を選び、台所で一緒に料理します。合成データです。",
      facts: { language: "日本語" },
      highlights: ["（サンプル）朝市で旬の野菜を選ぶ", "（サンプル）選んだ野菜で一品を仕上げる", "（サンプル）できた料理をみんなで味わう"],
      description: "（サンプル）朝市を歩いて食材を選び、台所で一緒に料理します。合成データです。",
      included: ["（サンプル）食材と調理道具", "（サンプル）お茶"],
      notIncluded: ["（サンプル）駅からの交通費"],
      notSuitableFor: ["（サンプル）生ものが苦手な方"],
      timeline: [
        { time: "08:30", title: "（サンプル）朝市で買い物", text: "（サンプル）野菜を選びます。", photoObjectKey: null },
        { time: "10:00", title: "（サンプル）台所で調理", text: "", photoObjectKey: null },
      ],
      knowBeforeYouGo: ["（サンプル）歩きやすい靴で来てください。"],
      hostUserIds: [hostUserId],
    },
    photoObjectKeys: [],
    photoAlts: [],
    offers: [{ ...defaultOffer("sample-offer-kitchen-market", "（サンプル）朝市と料理"), startTime: "08:30" }],
    // 一部の項目だけ英訳がある（作られていない項目と、日本語を直すと空に戻る動きを画面で確かめる合成データ）
    englishOf: {
      "（サンプル）朝市で買って、台所で作る": "(Sample) Shop at the morning market, cook in the kitchen",
      "（サンプル）朝市で野菜を選び、台所で一緒に料理します。合成データです。": "(Sample) Pick vegetables at the morning market and cook together in the kitchen. Synthetic data.",
      "日本語": "Japanese",
      "（サンプル）朝市で旬の野菜を選ぶ": "(Sample) Choose seasonal vegetables at the market",
      "（サンプル）選んだ野菜で一品を仕上げる": "(Sample) Finish a dish with the vegetables you chose",
      "（サンプル）朝市を歩いて食材を選び、台所で一緒に料理します。合成データです。": "(Sample) Walk the market, choose ingredients and cook together in the kitchen. Synthetic data.",
      "（サンプル）食材と調理道具": "(Sample) Ingredients and cooking tools",
      "（サンプル）駅からの交通費": "(Sample) Transport from the station",
      "（サンプル）朝市で買い物": "(Sample) Shopping at the market",
      "（サンプル）野菜を選びます。": "(Sample) You choose the vegetables.",
    },
    offerBookings: {},
    bookingsThisWeek: 0,
    meetingPoint: {
      mode: "OVERRIDE",
      value: {
        overview: "（サンプル）朝市の入口",
        address: "（サンプル）サンプル市サンプル町の広場（架空）",
        accessNote: "（サンプル）駅の西口から歩いて 5 分です。",
        mapUrl: "",
        entranceNote: "（サンプル）青い旗の下で待ち合わせます。",
      },
    },
    listing: null,
    createdAt: iso(base, -5 * DAY_MS),
    updatedAt: iso(base, -1 * DAY_MS),
  };
  return { pages: [published, draft], photos };
}

type FailureDetails = { reason?: ExperienceHostErrorReason; field?: string; slug?: string; pageId?: string; blockers?: ExperienceProviderPagePublishBlocker[] };

/** 失敗の本文（契約の ExperienceHostErrorResponse）。400 は supportId が null、ほかは問い合わせ用の ID を持つ。 */
export type MockErrors = {
  /** 400：形が違う（提供者・集合場所・掲載・写真の上げ口。理由なし）。 */
  badRequest(): Response;
  /** 400：体験ページの入力（理由と項目の場所）。 */
  pageInvalid(reason: ExperienceHostErrorReason, field: string): Response;
  /** 400 以外（理由が無ければ理由なしの組）。 */
  fail(status: number, code: ExperienceHostErrorCode, details?: FailureDetails): Response;
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

export function createMockErrors(): MockErrors {
  let issued = 0;
  return {
    badRequest: () => jsonResponse(400, { error: { code: "VALIDATION_ERROR", message: "mock: VALIDATION_ERROR", supportId: null, details: {} } }),
    pageInvalid: (reason, field) => jsonResponse(400, { error: { code: "VALIDATION_ERROR", message: `mock: ${reason}`, supportId: null, details: { reason, field } } }),
    fail: (status, code, details = {}) => {
      issued += 1;
      const supportId = `sample-support-${issued}`;
      const requestId = `sample-request-${issued}`;
      return jsonResponse(status, { error: { code, message: `mock: ${details.reason ?? code}`, supportId, details: { ...details, supportId, requestId } } });
    },
  };
}

export type MockPagesContext = {
  now: () => Date;
  errors: MockErrors;
  /** mock のログイン中の本人（プレビューのホストの表示名に使う）。 */
  hostUser: { id: string; displayName: string };
  /** 写真の保存が止まっている（上げ口が 503 `uploads_disabled`）。 */
  uploadsDisabled: boolean;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isHttpsUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** 集合場所の全項目（前後の空白を除く）。形が違えば null（400）。 */
function readMeetingPointInput(value: unknown): ExperienceProviderMeetingPoint | null {
  const limits = { overview: 200, address: 500, accessNote: 2000, mapUrl: 2048, entranceNote: 2000 } as const;
  if (!isObject(value) || Object.keys(value).length !== 5) return null;
  const result: Record<string, string> = {};
  for (const [key, max] of Object.entries(limits)) {
    const item = value[key];
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed.length > max) return null;
    result[key] = trimmed;
  }
  if (result.mapUrl !== "" && !isHttpsUrl(result.mapUrl!)) return null;
  return result as ExperienceProviderMeetingPoint;
}

/** slug を小文字化し、記号をハイフンにする（規則は SLUG_PATTERN：3〜64 字）。 */
function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

type Invalid = { reason: ExperienceHostErrorReason; field: string };
const invalid = (reason: ExperienceHostErrorReason, field: string): Invalid => ({ reason, field });
const isInvalid = (value: unknown): value is Invalid => isObject(value) && typeof value.reason === "string" && typeof value.field === "string" && Object.keys(value).length === 2;

/** 文字列の並び（null と空は落とす）。上限を超えれば Invalid。 */
function readTextList(value: unknown, field: string, maxItems: number, maxLength: number): string[] | Invalid {
  if (value === null) return [];
  if (!Array.isArray(value)) return invalid("PAGE_CONTENT_INVALID", field);
  const items: string[] = [];
  for (const [index, item] of value.entries()) {
    if (item === null) continue;
    if (typeof item !== "string" || item.trim().length > maxLength) return invalid("PAGE_CONTENT_INVALID", `${field}.${index}`);
    if (item.trim()) items.push(item.trim());
  }
  return items.length > maxItems ? invalid("PAGE_CONTENT_INVALID", field) : items;
}

function readText(value: unknown, field: string, maxLength: number): string | Invalid {
  if (value === null) return "";
  if (typeof value !== "string" || value.trim().length > maxLength) return invalid("PAGE_CONTENT_INVALID", field);
  return value.trim();
}

/** 本文の部分更新（送った項目だけ）。写真の識別子は、この提供者が上げた写真だけ。 */
function applyContentInput(base: ExperienceProviderPageContent, value: unknown, photos: Set<string>): ExperienceProviderPageContent | Invalid {
  if (!isObject(value)) return invalid("PAGE_CONTENT_INVALID", "content");
  const content = structuredClone(base);
  const photoKey = (key: unknown, field: string): string | null | Invalid =>
    key === null || key === undefined ? null : typeof key === "string" && photos.has(key) ? key : invalid("PAGE_CONTENT_INVALID", field);
  for (const [key, item] of Object.entries(value)) {
    const field = `content.${key}`;
    let next: unknown;
    switch (key) {
      case "lead":
        next = readText(item, field, 400);
        if (!isInvalid(next)) content.lead = next as string;
        break;
      case "description":
        next = readText(item, field, 4000);
        if (!isInvalid(next)) content.description = next as string;
        break;
      case "facts":
        if (item !== null && (!isObject(item) || Object.keys(item).some((name) => name !== "language"))) return invalid("PAGE_CONTENT_INVALID", field);
        next = readText(isObject(item) ? (item.language ?? null) : null, `${field}.language`, 60);
        if (!isInvalid(next)) content.facts = { language: next as string };
        break;
      case "highlights":
        next = readTextList(item, field, 6, 120);
        if (!isInvalid(next)) content.highlights = next as string[];
        break;
      case "included":
      case "notIncluded":
      case "notSuitableFor":
        next = readTextList(item, field, 8, 120);
        if (!isInvalid(next)) content[key] = next as string[];
        break;
      case "knowBeforeYouGo":
        next = readTextList(item, field, 8, 200);
        if (!isInvalid(next)) content.knowBeforeYouGo = next as string[];
        break;
      case "hostUserIds":
        next = readTextList(item, field, 4, 200);
        if (!isInvalid(next)) content.hostUserIds = next as string[];
        break;
      case "timeline": {
        if (item !== null && !Array.isArray(item)) return invalid("PAGE_CONTENT_INVALID", field);
        const timeline: ExperienceProviderPageContent["timeline"] = [];
        for (const [index, entry] of (Array.isArray(item) ? item : []).entries()) {
          if (entry === null) continue;
          const at = `${field}.${index}`;
          if (!isObject(entry)) return invalid("PAGE_CONTENT_INVALID", at);
          const time = readText(entry.time ?? null, `${at}.time`, 5);
          const title = readText(entry.title ?? null, `${at}.title`, 60);
          const text = readText(entry.text ?? null, `${at}.text`, 200);
          const photoObjectKey = photoKey(entry.photoObjectKey, `${at}.photoObjectKey`);
          for (const part of [time, title, text, photoObjectKey]) if (isInvalid(part)) return part;
          if (time !== "" && !TIME_PATTERN.test(time as string)) return invalid("PAGE_CONTENT_INVALID", `${at}.time`);
          // 時刻・題・一言のどれも無い段は保存しない（数えるのはそのあと）
          if (time === "" && title === "" && text === "") continue;
          timeline.push({ time: time as string, title: title as string, text: text as string, photoObjectKey: photoObjectKey as string | null });
        }
        if (timeline.length > 6) return invalid("PAGE_CONTENT_INVALID", field);
        content.timeline = timeline;
        break;
      }
      case "meetingPoint": {
        if (item !== null && !isObject(item)) return invalid("PAGE_CONTENT_INVALID", field);
        const entranceNote = readText(isObject(item) ? (item.entranceNote ?? null) : null, `${field}.entranceNote`, 400);
        const exteriorPhotoObjectKey = photoKey(isObject(item) ? item.exteriorPhotoObjectKey : null, `${field}.exteriorPhotoObjectKey`);
        if (isInvalid(entranceNote)) return entranceNote;
        if (isInvalid(exteriorPhotoObjectKey)) return exteriorPhotoObjectKey;
        content.meetingPoint = { entranceNote, exteriorPhotoObjectKey };
        break;
      }
      default:
        return invalid("PAGE_CONTENT_INVALID", field);
    }
    if (isInvalid(next)) return next;
  }
  return content;
}

type IntegerRule = { min: number; max: number; nullable?: boolean };
const OFFER_INTEGERS: Record<string, IntegerRule> = {
  sortOrder: { min: 0, max: 10_000 },
  priceYen: { min: 0, max: 1_000_000 },
  childPriceYen: { min: 0, max: 1_000_000, nullable: true },
  childMinAge: { min: 0, max: 17, nullable: true },
  childMaxAge: { min: 0, max: 17, nullable: true },
  capacity: { min: 1, max: 500 },
  maxPartySize: { min: 1, max: 500 },
  minimumParticipants: { min: 1, max: 500 },
  durationMinutes: { min: 15, max: 720 },
  cutoffDays: { min: 0, max: 60 },
};
const OFFER_ENUMS: Record<string, readonly string[]> = {
  cancellationPolicy: ["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"],
  acceptanceMode: ["INSTANT", "APPROVAL"],
  spaceScope: ["ENTIRE_FACILITY", "DESIGNATED_AREA"],
};

function readBookingQuestions(value: unknown, field: string): ExperienceProviderPageBookingQuestion[] | Invalid {
  const bad = (at: string) => invalid("PAGE_OFFER_QUESTIONS_INVALID", at);
  if (!Array.isArray(value) || value.length > 5) return bad(field);
  const questions: ExperienceProviderPageBookingQuestion[] = [];
  for (const [index, item] of value.entries()) {
    const at = `${field}.${index}`;
    if (!isObject(item)) return bad(at);
    const { id, prompt, description = null, inputType, required = false, options = [] } = item;
    if (id !== undefined && (typeof id !== "string" || !QUESTION_ID_PATTERN.test(id))) return bad(`${at}.id`);
    if (typeof prompt !== "string" || prompt.trim().length < 1 || prompt.trim().length > 120) return bad(`${at}.prompt`);
    if (description !== null && (typeof description !== "string" || description.trim().length > 300)) return bad(`${at}.description`);
    if (inputType !== "SHORT_TEXT" && inputType !== "LONG_TEXT" && inputType !== "SINGLE_SELECT" && inputType !== "MULTI_SELECT") return bad(`${at}.inputType`);
    if (typeof required !== "boolean") return bad(`${at}.required`);
    if (!Array.isArray(options) || options.length > 8) return bad(`${at}.options`);
    const selectable = inputType === "SINGLE_SELECT" || inputType === "MULTI_SELECT";
    if (selectable !== options.length > 0) return bad(`${at}.options`);
    const parsedOptions: ExperienceProviderPageBookingQuestion["options"] = [];
    for (const [optionIndex, option] of options.entries()) {
      const optionAt = `${at}.options.${optionIndex}`;
      if (!isObject(option) || typeof option.label !== "string" || option.label.trim().length < 1 || option.label.trim().length > 80) return bad(optionAt);
      if (option.id !== undefined && (typeof option.id !== "string" || !QUESTION_ID_PATTERN.test(option.id))) return bad(`${optionAt}.id`);
      parsedOptions.push({ id: typeof option.id === "string" ? option.id : `o${optionIndex + 1}`, label: option.label.trim() });
    }
    questions.push({
      id: typeof id === "string" ? id : `q${index + 1}`,
      prompt: prompt.trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : null,
      inputType,
      required,
      options: parsedOptions,
    });
  }
  return questions;
}

/** 商品の部分更新（送った項目だけ）。 */
function applyOfferPatch(base: ExperienceProviderPageOffer, value: unknown, field: string): ExperienceProviderPageOffer | Invalid {
  const bad = (at: string) => invalid("PAGE_OFFER_INVALID", at);
  if (!isObject(value)) return bad(field);
  const offer: Record<string, unknown> = structuredClone(base);
  for (const [key, item] of Object.entries(value)) {
    const at = `${field}.${key}`;
    const integer = OFFER_INTEGERS[key];
    const choices = OFFER_ENUMS[key];
    if (key === "id") continue;
    if (integer) {
      if (item === null && integer.nullable) offer[key] = null;
      else if (typeof item === "number" && Number.isInteger(item) && item >= integer.min && item <= integer.max) offer[key] = item;
      else return bad(at);
    } else if (choices) {
      if (typeof item !== "string" || !choices.includes(item)) return bad(at);
      offer[key] = item;
    } else if (key === "name") {
      if (typeof item !== "string" || item.trim().length < 1 || item.trim().length > 80) return bad(at);
      offer.name = item.trim();
    } else if (key === "shortDescription") {
      if (item !== null && (typeof item !== "string" || item.trim().length > 160)) return bad(at);
      offer.shortDescription = typeof item === "string" && item.trim() ? item.trim() : null;
    } else if (key === "isActive" || key === "adultRequiredForChild") {
      if (typeof item !== "boolean") return bad(at);
      offer[key] = item;
    } else if (key === "startTime") {
      if (typeof item !== "string" || !TIME_PATTERN.test(item)) return bad(at);
      offer.startTime = item;
    } else if (key === "weekdays") {
      if (!Array.isArray(item) || item.length > 7 || !item.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return bad(at);
      offer.weekdays = [...new Set(item as number[])].sort();
    } else if (key === "closedDates") {
      if (!Array.isArray(item) || item.length > 366 || !item.every((date) => typeof date === "string" && DATE_PATTERN.test(date))) return bad(at);
      offer.closedDates = [...new Set(item as string[])].sort();
    } else if (key === "useZone") {
      if (!Array.isArray(item) || item.length > 20 || !item.every((zone) => typeof zone === "string")) return bad(at);
      offer.useZone = item;
    } else if (key === "bookingQuestions") {
      const questions = readBookingQuestions(item, at);
      if (isInvalid(questions)) return questions;
      offer.bookingQuestions = questions;
    } else {
      return bad(at);
    }
  }
  const result = offer as ExperienceProviderPageOffer;
  if (result.maxPartySize > result.capacity) return bad(`${field}.maxPartySize`);
  if (result.minimumParticipants > result.capacity) return bad(`${field}.minimumParticipants`);
  if (result.childMinAge !== null && result.childMaxAge !== null && result.childMinAge > result.childMaxAge) return bad(`${field}.childMinAge`);
  return result;
}

function blockersOf(owner: MockPageOwner, page: Pick<MockPage, "title" | "photoObjectKeys" | "offers">): ExperienceProviderPagePublishBlocker[] {
  const blockers: ExperienceProviderPagePublishBlocker[] = [];
  const active = page.offers.filter((offer) => offer.isActive);
  if (!page.title.trim()) blockers.push("TITLE_REQUIRED");
  if (page.photoObjectKeys.length === 0) blockers.push("COVER_REQUIRED");
  if (active.some((offer) => offer.priceYen === 0)) blockers.push("OFFER_PRICE_REQUIRED");
  if (active.some((offer) => offer.weekdays.length === 0)) blockers.push("OFFER_WEEKDAYS_REQUIRED");
  if (active.length === 0) blockers.push("OFFER_ACTIVE_REQUIRED");
  if (owner.readiness !== "READY") blockers.push("STRIPE_NOT_READY");
  return blockers;
}

const bySortOrder = (a: ExperienceProviderPageOffer, b: ExperienceProviderPageOffer) => a.sortOrder - b.sortOrder;

export function pageDetail(owner: MockPageOwner, page: MockPage): ExperienceProviderPageDetail {
  const offers = [...page.offers].sort(bySortOrder);
  return {
    id: page.id,
    kind: "EXPERIENCE",
    slug: page.slug,
    language: page.language,
    title: page.title,
    status: page.status,
    listOnEntrance: page.listOnEntrance,
    publishedAt: page.publishedAt,
    unpublishedAt: page.unpublishedAt,
    content: structuredClone(page.content),
    photos: page.photoObjectKeys.map((objectKey) => ({ objectKey, url: photoUrl(objectKey, "w1024") })),
    coverObjectKey: page.photoObjectKeys[0] ?? null,
    offer: offers[0] ?? null,
    offers,
    publishBlockers: blockersOf(owner, page),
    publicPath: `/living/${owner.vesselSlug}/pages/${page.slug}`,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    photoAlts: [...page.photoAlts],
  };
}

function listItem(page: MockPage): ExperienceProviderPageListItem {
  const cover = page.photoObjectKeys[0];
  return {
    id: page.id,
    kind: "EXPERIENCE",
    slug: page.slug,
    language: page.language,
    title: page.title,
    coverUrl: cover ? photoUrl(cover, "w256") : null,
    status: page.status,
    listOnEntrance: page.listOnEntrance,
    bookingCounts: { confirmed: Object.values(page.offerBookings).reduce((sum, count) => sum + count, 0), thisWeek: page.bookingsThisWeek },
    updatedAt: page.updatedAt,
  };
}

/** JST の日付（YYYY-MM-DD）と曜日。 */
function jstDate(epochMs: number): { date: string; weekday: number } {
  const shifted = new Date(epochMs + JST_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay() };
}

function jstEpoch(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

function occurrencesOf(owner: MockPageOwner, offer: ExperienceProviderPageOffer, now: Date): ExperienceProviderPagePreviewOccurrence[] {
  const occurrences: ExperienceProviderPagePreviewOccurrence[] = [];
  const today = jstDate(now.getTime()).date;
  for (let day = 0; day < PREVIEW_DAYS; day += 1) {
    const { date, weekday } = jstDate(jstEpoch(today, "12:00") + day * DAY_MS);
    if (!offer.weekdays.includes(weekday) || offer.closedDates.includes(date)) continue;
    const start = jstEpoch(date, offer.startTime);
    const deadline = offer.cutoffDays === 0 ? start : jstEpoch(date, "23:59") - offer.cutoffDays * DAY_MS;
    const common = { date, startAt: new Date(start).toISOString(), endAt: new Date(start + offer.durationMinutes * 60_000).toISOString(), seatsLeft: offer.capacity };
    if (owner.readiness !== "READY") occurrences.push({ ...common, bookable: false, reason: "unavailable" });
    else if (now.getTime() > deadline) occurrences.push({ ...common, bookable: false, reason: "cutoff" });
    else occurrences.push({ ...common, bookable: true });
  }
  return occurrences;
}

async function fingerprint(questions: ExperienceProviderPageBookingQuestion[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(questions)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function preview(owner: MockPageOwner, page: MockPage, now: Date, hostUser: MockPagesContext["hostUser"]): Promise<ExperienceProviderPagePreviewResponse | null> {
  const active = page.offers.filter((offer) => offer.isActive).sort(bySortOrder).slice(0, 12);
  if (active.length === 0) return null;
  const summaries: ExperienceProviderPagePreviewOfferSummary[] = await Promise.all(
    active.map(async (offer) => ({
      id: offer.id,
      name: offer.name,
      shortDescription: offer.shortDescription,
      sortOrder: offer.sortOrder,
      priceYen: offer.priceYen,
      childPriceYen: offer.childPriceYen,
      childMinAge: offer.childMinAge,
      childMaxAge: offer.childMaxAge,
      adultRequiredForChild: offer.adultRequiredForChild,
      currency: "JPY" as const,
      capacity: offer.capacity,
      maxPartySize: offer.maxPartySize,
      minimumParticipants: offer.minimumParticipants,
      durationMinutes: offer.durationMinutes,
      startTime: offer.startTime,
      cancellationPolicy: offer.cancellationPolicy,
      acceptanceMode: offer.acceptanceMode,
      bookingQuestions: structuredClone(offer.bookingQuestions),
      bookingQuestionsFingerprint: await fingerprint(offer.bookingQuestions),
    })),
  );
  const offers = summaries.map((summary, index) => ({ ...summary, occurrences: occurrencesOf(owner, active[index]!, now) }));
  const { content } = page;
  // 鮮度確認済みの自動英訳は日本語のページだけ。今の原文に対応する英語があるものだけ入り、無い・古い項目は null
  const english = (text: string): string | null => (page.language === "JA" ? (page.englishOf[text] ?? null) : null);
  const englishList = (items: string[]) => items.map(english);
  return {
    page: {
      slug: page.slug,
      kind: "EXPERIENCE",
      language: page.language,
      title: page.title,
      titleEn: english(page.title),
      content: {
        lead: content.lead,
        leadEn: english(content.lead),
        facts: { language: content.facts.language, languageEn: english(content.facts.language) },
        highlights: [...content.highlights],
        highlightsEn: englishList(content.highlights),
        timeline: content.timeline.map((item) => {
          const photoIndex = item.photoObjectKey ? page.photoObjectKeys.indexOf(item.photoObjectKey) : -1;
          return { time: item.time, title: item.title, titleEn: english(item.title), text: item.text, textEn: english(item.text), photoIndex: photoIndex >= 0 ? photoIndex : null };
        }),
        description: content.description,
        descriptionEn: english(content.description),
        included: [...content.included],
        includedEn: englishList(content.included),
        notIncluded: [...content.notIncluded],
        notIncludedEn: englishList(content.notIncluded),
        notSuitableFor: [...content.notSuitableFor],
        notSuitableForEn: englishList(content.notSuitableFor),
        knowBeforeYouGo: [...content.knowBeforeYouGo],
        knowBeforeYouGoEn: englishList(content.knowBeforeYouGo),
      },
      photos: page.photoObjectKeys.map((objectKey) => ({ url: photoUrl(objectKey, "w1024") })),
      coverUrl: page.photoObjectKeys[0] ? photoUrl(page.photoObjectKeys[0], "w1024") : null,
    },
    spot: {
      slug: owner.vesselSlug,
      name: owner.provider.displayName,
      logoUrl: null,
      tagline: null,
      taglineEn: null,
      landingGround: "LIGHT",
      landingAccent: "LEAF",
      landingFont: "MARU",
      meetingPoint: null,
    },
    hosts: content.hostUserIds.filter((id) => id === hostUser.id).map(() => ({ displayName: hostUser.displayName, avatarUrl: null })),
    offers,
    offer: summaries[0]!,
    occurrences: offers[0]!.occurrences,
  };
}

const CREATE_FIELDS = ["kind", "title", "language", "slug"];
const PATCH_FIELDS = ["title", "language", "slug", "content", "photoObjectKeys", "photoAlts", "offer", "offers", "listOnEntrance"];

/**
 * 体験ページ・集合場所・掲載・写真の route。`rest` は `/api/experience-providers/{providerId}/` より後ろの path。
 * 扱わない path は null（mock.ts が 404 にする）。所属していない提供者は mock.ts が先に 404 にする。
 */
export function createMockPageRoutes(context: MockPagesContext) {
  const { now, errors } = context;
  let created = 0;
  let uploads = 0;

  /** ページの版を進める（時計が止まっていても前の版より後にする）。 */
  function touch(page: MockPage): void {
    const previous = Date.parse(page.updatedAt);
    page.updatedAt = new Date(Math.max(now().getTime(), previous + 1)).toISOString();
  }

  /** 掲載中の体験を止める（内容を変えたら再審査）。 */
  function pauseListing(page: MockPage): void {
    if (page.listing?.status !== "ACTIVE") return;
    const at = now().toISOString();
    page.listing = { ...page.listing, status: "PAUSED", pausedAt: at, updatedAt: at };
  }

  const json = jsonResponse;
  const pageNotFound = (pageId: string) => errors.fail(404, "NOT_FOUND", { reason: "PAGE_NOT_FOUND", pageId });

  function slugTaken(owner: MockPageOwner, slug: string, except?: MockPage): boolean {
    return owner.pages.some((page) => page !== except && page.slug === slug);
  }

  function create(owner: MockPageOwner, body: unknown): Response {
    if (!isObject(body)) return errors.pageInvalid("PAGE_REQUEST_INVALID", "");
    const unknownField = Object.keys(body).find((key) => !CREATE_FIELDS.includes(key));
    if (unknownField) return errors.pageInvalid("PAGE_REQUEST_INVALID", unknownField);
    if (body.kind !== "EXPERIENCE") return errors.pageInvalid("PAGE_REQUEST_INVALID", "kind");
    if (body.language !== "EN" && body.language !== "JA") return errors.pageInvalid("PAGE_REQUEST_INVALID", "language");
    if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length > 95)) return errors.pageInvalid("PAGE_TITLE_INVALID", "title");
    const title = typeof body.title === "string" ? body.title.trim() : "";
    created += 1;
    let slug: string;
    if (body.slug !== undefined) {
      if (typeof body.slug !== "string" || body.slug.length > 200) return errors.pageInvalid("PAGE_SLUG_INVALID", "slug");
      slug = normalizeSlug(body.slug);
      if (!SLUG_PATTERN.test(slug)) return errors.pageInvalid("PAGE_SLUG_INVALID", "slug");
      if (slugTaken(owner, slug)) return errors.fail(409, "CONFLICT", { reason: "PAGE_SLUG_TAKEN", field: "slug" });
    } else {
      const fromTitle = normalizeSlug(title).slice(0, 56).replace(/-+$/, "");
      const base = SLUG_PATTERN.test(fromTitle) ? fromTitle : `page-${created}`;
      slug = base;
      for (let suffix = 2; slugTaken(owner, slug); suffix += 1) slug = `${base}-${suffix}`;
    }
    const at = now().toISOString();
    const id = `sample-page-new-${created}`;
    const page: MockPage = {
      id,
      slug,
      language: body.language,
      title,
      status: "DRAFT",
      listOnEntrance: false,
      publishedAt: null,
      unpublishedAt: null,
      content: emptyContent(),
      photoObjectKeys: [],
      photoAlts: [],
      offers: [defaultOffer(`sample-offer-new-${created}`, body.language === "JA" ? "体験" : "Experience")],
      englishOf: {},
      offerBookings: {},
      bookingsThisWeek: 0,
      meetingPoint: { mode: "INHERIT" },
      listing: null,
      createdAt: at,
      updatedAt: at,
    };
    owner.pages.push(page);
    return json(201, pageDetail(owner, page));
  }

  function patch(owner: MockPageOwner, page: MockPage, body: unknown, version: string | null): Response {
    if (!isObject(body)) return errors.pageInvalid("PAGE_REQUEST_INVALID", "");
    const unknownField = Object.keys(body).find((key) => !PATCH_FIELDS.includes(key));
    if (unknownField) return errors.pageInvalid("PAGE_REQUEST_INVALID", unknownField);
    if (version !== null && version !== page.updatedAt) return errors.fail(409, "CONFLICT", { reason: "PAGE_UPDATED" });
    const next = structuredClone({ ...page, listing: null });

    if ("title" in body) {
      if (typeof body.title !== "string" || body.title.trim().length > 95) return errors.pageInvalid("PAGE_TITLE_INVALID", "title");
      next.title = body.title.trim();
    }
    if ("language" in body) {
      if (body.language !== "EN" && body.language !== "JA") return errors.pageInvalid("PAGE_REQUEST_INVALID", "language");
      next.language = body.language;
    }
    if ("listOnEntrance" in body) {
      if (typeof body.listOnEntrance !== "boolean") return errors.pageInvalid("PAGE_REQUEST_INVALID", "listOnEntrance");
      next.listOnEntrance = body.listOnEntrance;
    }
    if ("content" in body) {
      const content = applyContentInput(next.content, body.content, owner.photos);
      if (isInvalid(content)) return errors.pageInvalid(content.reason, content.field);
      next.content = content;
    }
    if ("photoAlts" in body && !("photoObjectKeys" in body)) return errors.pageInvalid("PAGE_PHOTOS_INVALID", "photoAlts");
    if ("photoObjectKeys" in body) {
      const keys = body.photoObjectKeys;
      if (!Array.isArray(keys) || keys.length > MAX_PHOTOS || !keys.every((key) => typeof key === "string" && key.length >= 1 && key.length <= 512)) {
        return errors.pageInvalid("PAGE_PHOTOS_INVALID", "photoObjectKeys");
      }
      let alts: string[];
      if ("photoAlts" in body) {
        const given = body.photoAlts;
        if (!Array.isArray(given) || given.length !== keys.length || !given.every((alt) => typeof alt === "string" && alt.trim().length <= 200)) {
          return errors.pageInvalid("PAGE_PHOTOS_INVALID", "photoAlts");
        }
        alts = given.map((alt: string) => alt.trim());
      } else {
        // 写真だけを送ると、同じ写真の説明を並びに合わせて保つ
        alts = (keys as string[]).map((key) => {
          const index = page.photoObjectKeys.indexOf(key);
          return index >= 0 ? (page.photoAlts[index] ?? "") : "";
        });
      }
      const foreign = (keys as string[]).findIndex((key) => !owner.photos.has(key));
      if (foreign >= 0) return errors.fail(422, "UNPROCESSABLE_ENTITY", { reason: "PAGE_PHOTOS_INVALID", field: `photoObjectKeys.${foreign}` });
      next.photoObjectKeys = [...(keys as string[])];
      next.photoAlts = alts;
    }
    // 当日の流れと外観写真の写真は photoObjectKeys の中から選ぶ。保存後の写真に無いものは null になる
    next.content.timeline = next.content.timeline.map((step) => (step.photoObjectKey && !next.photoObjectKeys.includes(step.photoObjectKey) ? { ...step, photoObjectKey: null } : step));
    if (next.content.meetingPoint.exteriorPhotoObjectKey && !next.photoObjectKeys.includes(next.content.meetingPoint.exteriorPhotoObjectKey)) next.content.meetingPoint = { ...next.content.meetingPoint, exteriorPhotoObjectKey: null };
    if ("offer" in body) {
      const [first] = [...next.offers].sort(bySortOrder);
      if (!first) return errors.pageInvalid("PAGE_OFFER_INVALID", "offer");
      const offer = applyOfferPatch(first, body.offer, "offer");
      if (isInvalid(offer)) return errors.pageInvalid(offer.reason, offer.field);
      next.offers = next.offers.map((item) => (item.id === offer.id ? offer : item));
    }
    if ("offers" in body) {
      if (!Array.isArray(body.offers) || body.offers.length > 50) return errors.pageInvalid("PAGE_OFFER_INVALID", "offers");
      const offers: ExperienceProviderPageOffer[] = [];
      for (const [index, item] of body.offers.entries()) {
        const field = `offers.${index}`;
        const id = isObject(item) ? item.id : undefined;
        const existing = typeof id === "string" ? next.offers.find((offer) => offer.id === id) : undefined;
        if (id !== undefined && (!existing || offers.some((offer) => offer.id === id))) return errors.pageInvalid("PAGE_OFFER_INVALID", `${field}.id`);
        const base = existing ?? { ...defaultOffer(`sample-offer-new-${created}-${index + 1}`, next.language === "JA" ? "体験" : "Experience"), sortOrder: index };
        const offer = applyOfferPatch(base, item, field);
        if (isInvalid(offer)) return errors.pageInvalid(offer.reason, offer.field);
        offers.push(offer);
      }
      const removedWithBookings = next.offers.some((offer) => !offers.some((kept) => kept.id === offer.id) && (page.offerBookings[offer.id] ?? 0) > 0);
      if (removedWithBookings) return errors.fail(409, "CONFLICT", { reason: "PAGE_OFFER_HAS_BOOKINGS" });
      created += 1;
      next.offers = offers;
    }
    if ("slug" in body) {
      if (typeof body.slug !== "string" || body.slug.length > 200) return errors.pageInvalid("PAGE_SLUG_INVALID", "slug");
      const slug = normalizeSlug(body.slug);
      if (!SLUG_PATTERN.test(slug)) return errors.pageInvalid("PAGE_SLUG_INVALID", "slug");
      if (slug !== page.slug) {
        if (page.publishedAt !== null) return errors.fail(409, "CONFLICT", { reason: "PAGE_SLUG_LOCKED", field: "slug", slug: page.slug });
        if (slugTaken(owner, slug, page)) return errors.fail(409, "CONFLICT", { reason: "PAGE_SLUG_TAKEN", field: "slug" });
      }
      next.slug = slug;
    }
    if (page.status === "PUBLISHED") {
      const blockers = blockersOf(owner, next);
      if (blockers.length > 0) return errors.fail(422, "UNPROCESSABLE_ENTITY", { reason: "PAGE_PUBLISH_BLOCKED", blockers });
    }
    Object.assign(page, { ...next, listing: page.listing });
    touch(page);
    pauseListing(page);
    return json(200, pageDetail(owner, page));
  }

  function remove(owner: MockPageOwner, page: MockPage): Response {
    if (page.publishedAt !== null) return errors.fail(409, "CONFLICT", { reason: "PAGE_DELETE_PUBLISHED" });
    if (Object.values(page.offerBookings).some((count) => count > 0)) return errors.fail(409, "CONFLICT", { reason: "PAGE_DELETE_HAS_BOOKINGS" });
    owner.pages = owner.pages.filter((item) => item !== page);
    return json(200, { id: page.id, deleted: true });
  }

  function publish(owner: MockPageOwner, page: MockPage, version: string | null): Response {
    if (version !== null && version !== page.updatedAt) return errors.fail(409, "CONFLICT", { reason: "PAGE_UPDATED" });
    const blockers = blockersOf(owner, page);
    if (blockers.length > 0) return errors.fail(422, "UNPROCESSABLE_ENTITY", { reason: "PAGE_PUBLISH_BLOCKED", blockers });
    if (page.status !== "PUBLISHED") {
      page.status = "PUBLISHED";
      page.publishedAt ??= now().toISOString();
      touch(page);
    }
    return json(200, pageDetail(owner, page));
  }

  function unpublish(owner: MockPageOwner, page: MockPage): Response {
    if (page.publishedAt === null) return errors.fail(409, "CONFLICT", { reason: "PAGE_NOT_PUBLISHED" });
    if (page.status === "PUBLISHED") {
      page.status = "UNPUBLISHED";
      page.unpublishedAt = now().toISOString();
      touch(page);
      pauseListing(page);
    }
    return json(200, pageDetail(owner, page));
  }

  function pageMeetingPoint(owner: MockPageOwner, page: MockPage) {
    return page.meetingPoint.mode === "OVERRIDE"
      ? { mode: "OVERRIDE" as const, meetingPoint: { ...page.meetingPoint.value } }
      : { mode: "INHERIT" as const, meetingPoint: { ...owner.meetingPoint } };
  }

  function updatePageMeetingPoint(owner: MockPageOwner, pageId: string, body: unknown): Response {
    if (!isObject(body) || typeof body.expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(body.expectedUpdatedAt))) return errors.badRequest();
    let next: MockPage["meetingPoint"];
    if (body.mode === "INHERIT" && Object.keys(body).length === 2) next = { mode: "INHERIT" };
    else if (body.mode === "OVERRIDE" && Object.keys(body).length === 3) {
      const value = readMeetingPointInput(body.meetingPoint);
      if (!value) return errors.badRequest();
      next = { mode: "OVERRIDE", value };
    } else return errors.badRequest();
    const page = owner.pages.find((item) => item.id === pageId);
    if (!page) return errors.fail(404, "NOT_FOUND", { reason: "PROVIDER_PAGE_NOT_FOUND" });
    if (body.expectedUpdatedAt !== page.updatedAt) return errors.fail(409, "CONFLICT", { reason: "PROVIDER_PAGE_CONFLICT" });
    page.meetingPoint = next;
    touch(page);
    pauseListing(page);
    const current = pageMeetingPoint(owner, page);
    return json(200, current.mode === "OVERRIDE" ? { mode: "OVERRIDE", updatedAt: page.updatedAt, meetingPoint: current.meetingPoint } : { mode: "INHERIT", updatedAt: page.updatedAt });
  }

  function listingResponse(page: MockPage) {
    return { listing: page.listing ? { ...page.listing } : null, consent: MOCK_LISTING_CONSENT };
  }

  function requestListing(owner: MockPageOwner, pageId: string, body: unknown): Response {
    if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.consentVersion !== "string" || body.consentVersion.length < 1 || body.consentVersion.length > 100) {
      return errors.badRequest();
    }
    const page = owner.pages.find((item) => item.id === pageId);
    if (!page) return errors.fail(404, "NOT_FOUND", { reason: "EXPERIENCE_LISTING_NOT_FOUND" });
    if (body.consentVersion !== MOCK_LISTING_CONSENT.version) return errors.fail(422, "UNPROCESSABLE_ENTITY", { reason: "EXPERIENCE_LISTING_CONSENT_OUTDATED" });
    if (page.status !== "PUBLISHED" || page.language !== "EN") return errors.fail(422, "UNPROCESSABLE_ENTITY", { reason: "EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE" });
    const at = now().toISOString();
    if (!page.listing) {
      page.listing = {
        id: `sample-listing-${page.id}`,
        spotId: owner.provider.vesselSpotId,
        campaignPageId: page.id,
        status: "REQUESTED",
        slug: null,
        regionKey: null,
        consentVersion: body.consentVersion,
        consentedAt: at,
        approvedAt: null,
        pausedAt: null,
        withdrawnAt: null,
        createdAt: at,
        updatedAt: at,
      };
    } else {
      const status = page.listing.status === "WITHDRAWN" ? "REQUESTED" : page.listing.status;
      page.listing = { ...page.listing, status, consentVersion: body.consentVersion, consentedAt: at, updatedAt: at };
    }
    return json(200, listingResponse(page));
  }

  function withdrawListing(owner: MockPageOwner, pageId: string): Response {
    const page = owner.pages.find((item) => item.id === pageId);
    if (!page?.listing) return errors.fail(404, "NOT_FOUND", { reason: "EXPERIENCE_LISTING_NOT_FOUND" });
    if (page.listing.status !== "WITHDRAWN") {
      const at = now().toISOString();
      page.listing = { ...page.listing, status: "WITHDRAWN", withdrawnAt: at, updatedAt: at };
    }
    return json(200, listingResponse(page));
  }

  function uploadPolicy(owner: MockPageOwner, body: unknown): Response {
    if (!isObject(body) || Object.keys(body).some((key) => !["purpose", "contentType", "contentLength"].includes(key))) return errors.badRequest();
    const { purpose, contentType, contentLength = null } = body;
    const extension = typeof contentType === "string" ? PHOTO_EXTENSIONS[contentType] : undefined;
    if (purpose !== "ARTICLE_IMAGE" || !extension) return errors.badRequest();
    if (contentLength !== null && !(typeof contentLength === "number" && Number.isInteger(contentLength) && contentLength >= 1 && contentLength <= MAX_PHOTO_BYTES)) {
      return errors.badRequest();
    }
    if (context.uploadsDisabled) return errors.fail(503, "SERVICE_UNAVAILABLE", { reason: "uploads_disabled" });
    uploads += 1;
    const objectKey = `sample-photos/${owner.vesselSlug}/upload-${uploads}.${extension}`;
    // mock は送られた写真を受け取れないので、発行した時点で上げ終えた写真として扱う（体験ページ・署名つき URL に使える）
    owner.photos.add(objectKey);
    const expiresAt = iso(now(), UPLOAD_TTL_MS);
    return json(201, {
      uploadId: `sample-upload-${uploads}`,
      objectKey,
      upload: {
        url: `${MOCK_UPLOAD_ORIGIN}/sample-bucket`,
        fields: {
          key: objectKey,
          "Content-Type": contentType as string,
          success_action_status: "201",
          policy: "c2FtcGxlLXBvbGljeQ",
          "x-goog-algorithm": "GOOG4-RSA-SHA256",
          "x-goog-credential": "sample-credential",
          "x-goog-date": "20261021T000000Z",
          "x-goog-signature": "sample-signature",
        },
      },
      expiresAt,
      maxSizeBytes: MAX_PHOTO_BYTES,
    });
  }

  function uploadSignedUrl(owner: MockPageOwner, body: unknown): Response {
    if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.objectKey !== "string" || body.objectKey.length < 1) return errors.badRequest();
    if (context.uploadsDisabled) return errors.fail(503, "SERVICE_UNAVAILABLE", { reason: "uploads_disabled" });
    if (!owner.photos.has(body.objectKey)) return errors.fail(404, "NOT_FOUND");
    return json(200, { objectKey: body.objectKey, signedUrl: `${MOCK_UPLOAD_ORIGIN}/view/${body.objectKey}`, expiresAt: iso(now(), UPLOAD_TTL_MS) });
  }

  /** 提供者の集合場所の既定を直す（掲載中の体験は止まる）。 */
  function updateMeetingPoint(owner: MockPageOwner, body: unknown): Response {
    const value = readMeetingPointInput(body);
    if (!value) return errors.badRequest();
    owner.meetingPoint = value;
    owner.pages.forEach(pauseListing);
    return json(200, { meetingPoint: { ...value } });
  }

  return {
    async route(owner: MockPageOwner, isOwner: boolean, method: string, rest: string[], request: Request, readBody: () => Promise<unknown>): Promise<Response | null> {
      const [head, pageId, action, ...extra] = rest;
      if (head === "meeting-point" && rest.length === 1) {
        if (method === "GET") return json(200, { meetingPoint: { ...owner.meetingPoint } });
        if (method === "PUT") return updateMeetingPoint(owner, await readBody());
        return null;
      }
      if (head === "uploads" && rest.length === 2) {
        if (pageId === "policies" && method === "POST") return uploadPolicy(owner, await readBody());
        if (pageId === "signed-url" && method === "POST") return uploadSignedUrl(owner, await readBody());
        return null;
      }
      if (head !== "pages" || extra.length > 0) return null;
      if (pageId === undefined) {
        if (method === "GET") {
          const pages = [...owner.pages].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(listItem);
          return json(200, { checkoutEnabled: true, pages });
        }
        if (method === "POST") return create(owner, await readBody());
        return null;
      }
      const version = request.headers.get("x-niho-page-updated-at");
      const page = owner.pages.find((item) => item.id === pageId);
      if (action === "experience-site-listing") {
        // 掲載は OWNER だけ（EDITOR は所属していないのと同じ 404・理由なし）
        if (!isOwner) return errors.fail(404, "NOT_FOUND");
        if (method === "GET") return page ? json(200, listingResponse(page)) : errors.fail(404, "NOT_FOUND", { reason: "PROVIDER_PAGE_NOT_FOUND" });
        if (method === "PUT") return requestListing(owner, pageId, await readBody());
        if (method === "DELETE") return withdrawListing(owner, pageId);
        return null;
      }
      if (action === "meeting-point") {
        if (method === "GET") return page ? json(200, pageMeetingPoint(owner, page)) : errors.fail(404, "NOT_FOUND", { reason: "PROVIDER_PAGE_NOT_FOUND" });
        if (method === "PUT") return updatePageMeetingPoint(owner, pageId, await readBody());
        return null;
      }
      if (action === undefined) {
        if (!["GET", "PATCH", "DELETE"].includes(method)) return null;
        if (!page) return pageNotFound(pageId);
        if (method === "GET") return json(200, pageDetail(owner, page));
        if (method === "PATCH") return patch(owner, page, await readBody(), version);
        return remove(owner, page);
      }
      const routes: Record<string, { method: string; run: (page: MockPage) => Promise<Response> | Response }> = {
        publish: { method: "POST", run: (target) => publish(owner, target, version) },
        unpublish: { method: "POST", run: (target) => unpublish(owner, target) },
        preview: {
          method: "GET",
          run: async (target) => {
            const body = await preview(owner, target, now(), context.hostUser);
            return body ? json(200, body) : pageNotFound(target.id);
          },
        },
      };
      const handler = routes[action];
      if (!handler || handler.method !== method) return null;
      return page ? handler.run(page) : pageNotFound(pageId);
    },
  };
}
