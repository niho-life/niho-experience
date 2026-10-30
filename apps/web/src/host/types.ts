import type { ExperienceConditionKind } from "@niho-experience/api-client";
import type { ExperienceProviderMeetingPoint, ExperienceProviderPaymentReadinessReason } from "@niho-experience/api-client/host";
import type { HostProviderKind, HostProviderReviewStatus } from "@/lib/host/providers";
import type { HostReviewTag } from "./reviews";

/*
 * What the host console screens show (#84). The provider's own values (kind, review
 * status, payout readiness) are the host contract's types (#87). Experiences, bookings,
 * messages, reviews, sales and the notification defaults are not in the contract yet, so they stay
 * hand-written from the screens' needs; the screens keep reading these shapes. The meeting defaults
 * are NIHO's shape. The
 * calendar and notification settings follow NIHO's own specs for them (#109).
 */

/** One listing state per experience page: draft → review → live (or paused). */
export type ListingStatus = "draft" | "review" | "live" | "paused";

/**
 * 書く言語 (#110): the language the host writes the page in. The experience site shows the page
 * in English either way: written in English, the text is the public English as it is; written in
 * Japanese, NIHO drafts the English and the host checks and confirms it (page-english.ts).
 */
export type HostWritingLanguage = "ja" | "en";

/** 0 = Sunday … 6 = Saturday, as in NIHO's offers. Screens list them from Monday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface HostExperiencePhoto {
  /** Stable while editing: NIHO's photo id once #87 is connected, a local one for a photo picked in this browser. */
  id: string;
  /** A public path, or a blob: URL for a photo picked in this browser and not uploaded yet. */
  url: string;
  alt: string;
}

/** One step of 当日の流れ. */
export interface HostTimelineStep {
  /** Stable while editing, so the step's Japanese stays with it (a local one for a step added in this browser). */
  id: string;
  /** "18:00" (JST); empty until set. Shared by both languages. */
  time: string;
  title: string;
  text: string;
}

/** Where guests meet for this experience. */
export interface HostExperienceMeeting {
  /** Shown on the public page. */
  area: string;
  /** Sent only after a booking is confirmed. */
  entrance: string;
  /** The building or its entrance; null until chosen. */
  exteriorPhotoUrl: string | null;
}

/** One bookable offer of an experience (申込の設定). Numbers stay null until the host fills them in. */
export interface HostOffer {
  id: string;
  name: string;
  adultPriceYen: number | null;
  /** Optional. */
  childPriceYen: number | null;
  capacity: number | null;
  /** "18:00" (JST); empty until set. */
  startTime: string;
  durationMinutes: number | null;
  weekdays: readonly Weekday[];
  /** Days it does not run (YYYY-MM-DD, JST), in date order. */
  closedDates: readonly string[];
  /** Asked when a guest books (optional). */
  questions: readonly string[];
}

/*
 * 参加の条件 (#110, niho-app#19318): what a guest should know before booking, kept as the host's
 * choices per kind, with a short note. NIHO writes the English the experience site shows from them
 * (the headline, the detail and whether a guest agrees to it before booking: journey.ts
 * ExperienceConditionItem); the console never writes that English. The kinds are the traveler
 * side's (EXPERIENCE_CONDITION_KINDS), one of each at most.
 * Hand-written from the screen's needs. TODO(#87): NIHO の API（niho-coliving/niho-app#19318）が入ったら合わせる。
 */

/** 年齢: the lowest age (null = 指定なし) and whether children join with an adult. */
export interface HostAgeCondition {
  minimumAge: number | null;
  withAdult: boolean;
  /** 補足, in the public English (the Japanese is the page's `japanese`). Empty when there is none. */
  note: string;
}

/** 座る: なし / いす / 床に座る. */
export type HostSeating = "NONE" | "CHAIR" | "FLOOR";
/** 歩く: ほとんど歩かない / 少し歩く / よく歩く. */
export type HostWalking = "LITTLE" | "SOME" | "LOTS";

/** 体の負担: sitting (and for about how long) and walking. */
export interface HostPhysicalCondition {
  seating: HostSeating;
  /** 時間の目安 (minutes) of sitting; null when not given. */
  seatedMinutes: number | null;
  walking: HostWalking;
  note: string;
}

/** The host's English: 流暢 / 日常会話 / かんたん / 話さない. */
export type HostEnglishLevel = "FLUENT" | "CONVERSATIONAL" | "BASIC" | "NONE";

/** ホストの言語. */
export interface HostLanguageCondition {
  /** 日本語を話す. */
  japanese: boolean;
  english: HostEnglishLevel;
  /** 英語の案内資料あり. */
  englishGuide: boolean;
  note: string;
}

/** What is served: 食事 / 軽食 / 飲み物だけ / 出ない. */
export type HostFoodServed = "MEAL" | "SNACK" | "DRINKS" | "NONE";
/** 対応できる食事: ベジタリアン / ヴィーガン / ハラール / グルテンフリー / アレルギーは相談. */
export type HostDiet = "VEGETARIAN" | "VEGAN" | "HALAL" | "GLUTEN_FREE" | "ALLERGY_ASK";

/** 食べもの. NIHO also asks guests their food wishes when they book (its own question, not this screen's). */
export interface HostFoodCondition {
  served: HostFoodServed;
  /** In the order conditions.ts lists them. */
  diets: readonly HostDiet[];
  note: string;
}

/** 段差・車いす: 段差なし・車いす可 / 一部段差あり（相談）/ 段差あり・車いす不可. */
export type HostAccess = "STEP_FREE" | "SOME_STEPS" | "STEPS";

export interface HostAccessCondition {
  access: HostAccess;
  note: string;
}

/** 雨の日: 雨でも開催（屋内）/ 小雨なら開催 / 雨天は中止（全額返金）. */
export type HostRainPlan = "INDOOR" | "LIGHT_RAIN" | "CANCELLED";

export interface HostWeatherCondition {
  rain: HostRainPlan;
  note: string;
}

/** Each kind's choices. */
export interface HostConditionValues {
  AGE: HostAgeCondition;
  PHYSICAL: HostPhysicalCondition;
  HOST_LANGUAGE: HostLanguageCondition;
  FOOD: HostFoodCondition;
  ACCESS: HostAccessCondition;
  WEATHER: HostWeatherCondition;
}

/** 参加の条件 by kind; null is 未設定 (none is required). */
export type HostParticipationConditions = { readonly [K in ExperienceConditionKind]: HostConditionValues[K] | null };

/** 当日の流れ's words for one step; its time is the step's own. */
export interface HostTimelineText {
  title: string;
  text: string;
}

/** An offer's words: its name and the questions asked when booking. Its prices and days are the offer's own. */
export interface HostOfferText {
  name: string;
  questions: readonly string[];
}

/**
 * The words of a page in one language (#110): the fields written once per language, in the public
 * order. Photos, times, prices, capacity and the conditions' choices are shared and stay out of it.
 */
export interface HostPageText {
  title: string;
  lead: string;
  dayLanguage: string;
  highlights: readonly string[];
  description: string;
  included: readonly string[];
  notIncluded: readonly string[];
  notSuitableFor: readonly string[];
  /** 参加の条件's notes, by kind. */
  conditions: Readonly<Partial<Record<ExperienceConditionKind, string>>>;
  /** By step id. */
  timeline: Readonly<Record<string, HostTimelineText>>;
  /** 公開する集合エリア and 入口の案内. */
  meeting: { area: string; entrance: string };
  knowBeforeYouGo: readonly string[];
  /** By offer id. */
  offers: Readonly<Record<string, HostOfferText>>;
}

/** One field of a page's words: what 日本語を変えました points at. */
export type HostPageTextField = keyof HostPageText;

/**
 * Where the English of a page written in Japanese comes from (#110). NIHO drafts the English from
 * the Japanese; the host corrects and confirms it. Only the English last confirmed goes to review
 * and to the experience site. The rules are page-english.ts's.
 */
export interface HostEnglishSource {
  /** The Japanese NIHO made the English from (英語の下書きを作る / 作り直す); null when it made none since the last 英語を確定. */
  draftedFrom: HostPageText | null;
  /** The Japanese the host confirmed the English against (英語を確定); null until the English is confirmed once. */
  confirmedFrom: HostPageText | null;
  /** The fields whose English the host corrected since NIHO made it or the host confirmed it. */
  edited: readonly HostPageTextField[];
}

/**
 * Everything 保存 keeps: the page text in the public order, its photos and its offers (#89), and
 * its Japanese and conditions (#110). The text fields are the page's English: as the host writes
 * it, or (written in Japanese) NIHO's draft as the host corrects and confirms it.
 */
export interface HostExperienceContent {
  /** The English title, which the list and the other screens name the experience by. */
  title: string;
  writingLanguage: HostWritingLanguage;
  /**
   * The page's words in Japanese while it is written in Japanese; null for a page never written
   * in Japanese. Kept when the host goes back to writing English, so it returns with 日本語.
   */
  japanese: HostPageText | null;
  englishSource: HostEnglishSource;
  /** ひとこと紹介. */
  lead: string;
  /** 当日の言語 ("English and Japanese"). */
  dayLanguage: string;
  highlights: readonly string[];
  description: string;
  included: readonly string[];
  notIncluded: readonly string[];
  notSuitableFor: readonly string[];
  conditions: HostParticipationConditions;
  timeline: readonly HostTimelineStep[];
  meeting: HostExperienceMeeting;
  knowBeforeYouGo: readonly string[];
  /** The first photo is the cover. */
  photos: readonly HostExperiencePhoto[];
  offers: readonly HostOffer[];
}

/** The listing's one state. 掲載を申請, 掲載を止める and 申請を取り下げる change it; 保存 does not. */
export interface HostListing {
  status: ListingStatus;
  /** When the listing went live (YYYY-MM-DD, JST). */
  liveSince?: string;
  /** When the listing was submitted for review (YYYY-MM-DD, JST). */
  requestedOn?: string;
}

export interface HostExperience extends HostExperienceContent, HostListing {
  id: string;
  /** The public page's path segment: /experiences/{slug}. */
  slug: string;
  // What the list and the home rows show, derived from the page (editor.ts listingSummary).
  /** Public path under /public; null shows a plain sand thumbnail. */
  cover: string | null;
  schedule: { weekdays: readonly string[]; start: string; durationMinutes: number; capacity: number; priceFromYen: number } | null;
  /** What a draft still needs before it can be submitted ("表紙写真", "料金"). */
  missing: readonly string[];
}

/**
 * A booking's one state (#90), in the words of NIHO's provider bookings: a request waiting
 * for the host (承認待ち), a booking (確定), one the traveler asked to cancel (要返金), and
 * the ends: 取消済み, お断り (declined by the host) and 期限切れ (not answered in time).
 */
export type HostBookingStatus = "pending" | "confirmed" | "refund_needed" | "cancelled" | "declined" | "expired";

/** The language the guest booked in; the cancellation message starts in it. */
export type HostGuestLanguage = "en" | "ja";

/** 取消理由: 運営者の都合 / 旅行者からの依頼 / その他. */
export type HostCancelReason = "host" | "guest" | "other";

/** 返金: the whole payment, half of it, or nothing. */
export type HostRefundChoice = "full" | "half" | "none";

/** An answer to one of the offer's questions (申込時の質問), as the guest wrote it. */
export interface HostBookingAnswer {
  question: string;
  answer: string;
}

/** One line of 時系列. */
export interface HostBookingEvent {
  /** YYYY-MM-DDTHH:MM in Japan. */
  at: string;
  text: string;
}

/**
 * 出欠 (#107): 来た / 来なかった, recorded by the host from the session's start (null = 未記録).
 * NIHO sends no thanks and no review request for a booking that did not come.
 */
export type HostAttendance = "attended" | "no_show";

/** The version of the meeting guide (集合案内) the guest has: NIHO sends it with the confirmation. */
export interface HostMeetingGuideCopy {
  version: number;
  /** YYYY-MM-DDTHH:MM in Japan; null until the booking is confirmed. */
  sentAt: string | null;
}

export interface HostBooking {
  id: string;
  experienceId: string;
  offerId: string;
  /** The offer's name when it was booked. */
  offer: string;
  /** The guest's name. NIHO never shows hosts the guest's email address: they write through the thread (#103). */
  guest: string;
  language: HostGuestLanguage;
  /** Where the guest lives (ISO 3166-1 alpha-2, "GB"; the screens write it in Japanese); null when they gave none. */
  country: string | null;
  /**
   * 食べものの希望 in short Japanese words ("ベジタリアン", "甲殻類なし"): NIHO's own field of the
   * booking, apart from the offer's questions. One word per guest who has it: two vegetarians
   * in one booking are written twice.
   */
  dietary: readonly string[];
  /**
   * The phone number the guest chose to give (optional). Only the session's own screen (この回,
   * #107) shows it; 予約, メッセージ and ホーム never carry it (console-data.ts bookingList).
   */
  phone: string | null;
  /** 出欠; null until the host records it. */
  attendance: HostAttendance | null;
  /** Local date and times in Japan (YYYY-MM-DD, HH:MM). */
  date: string;
  start: string;
  end: string;
  adults: number;
  children: number;
  /** adults + children. */
  guests: number;
  /** The prices when it was booked (yen, tax included). */
  adultPriceYen: number;
  childPriceYen: number | null;
  /** adults × the adult price + children × the child price. */
  amountYen: number;
  status: HostBookingStatus;
  channel: string;
  /** 申込メモ; empty when the guest wrote none. */
  note: string;
  answers: readonly HostBookingAnswer[];
  /** null when no guide goes with it (a request that was declined or expired). */
  meetingGuide: HostMeetingGuideCopy | null;
  // The times below are YYYY-MM-DDTHH:MM in Japan, null until they happen.
  /** 与信: the card hold when the guest booked. */
  authorizedAt: string | null;
  paidAt: string | null;
  /** Requests: by when the host must answer. */
  respondBy: string | null;
  cancelRequestedAt: string | null;
  cancelledAt: string | null;
  cancelReason: HostCancelReason | null;
  /** 取消連絡: what the guest was told when it was cancelled. */
  cancelMessage: string | null;
  /** 累計返金. */
  refundedYen: number;
  timeline: readonly HostBookingEvent[];
}

/*
 * メッセージ (#106, Epic #103): one thread per guest and experience. A question before booking
 * and, once the guest books, the booking's messages are the same thread. The host's reply
 * reaches the guest by email and the guest's email answer comes back into the thread; the
 * guest's address stays with NIHO. NIHO translates the guest's words into Japanese, and the
 * host checks the English of a reply before it is sent.
 * TODO(#87): NIHO's questions (niho-app#19319), booking messages (#19238) and notifications
 * (#19315) are not in the host contract yet.
 */

/** Whether NIHO could send the host's reply: 送信済み / 送れませんでした. */
export type HostMessageStatus = "sent" | "failed";

/** What a guest wrote, and NIHO's Japanese translation of it. */
export interface HostGuestMessage {
  id: string;
  from: "guest";
  /** YYYY-MM-DDTHH:MM in Japan. */
  at: string;
  /** The guest's own words. */
  original: string;
  /** The language they are in (BCP 47: "en", "ko"). */
  language: string;
  /** NIHO's Japanese translation; null when NIHO could not translate it (the screen shows the original). Unused for Japanese. */
  translation: string | null;
  /** The guest answered NIHO's email instead of writing on the site. */
  viaEmail: boolean;
}

/** What the host sent: the Japanese they wrote and the English they checked. */
export interface HostReplyMessage {
  id: string;
  from: "host";
  /** YYYY-MM-DDTHH:MM in Japan. */
  at: string;
  /** Empty when the host wrote the English directly. */
  japanese: string;
  /** What reached the guest. */
  english: string;
  status: HostMessageStatus;
}

export type HostThreadMessage = HostGuestMessage | HostReplyMessage;

/** The booking a thread is joined to, as 予約 has it. */
export interface HostThreadBooking {
  id: string;
  /** YYYY-MM-DD and HH:MM in Japan. */
  date: string;
  start: string;
  guests: number;
}

export interface HostThread {
  id: string;
  experienceId: string;
  /** The guest's name as they gave it (never their email). */
  guest: string;
  /** What the question is about ("子ども"); null when NIHO names none. */
  topic: string | null;
  /** Null for a question before booking. */
  booking: HostThreadBooking | null;
  /** In time order. */
  messages: readonly HostThreadMessage[];
}

/*
 * レビュー (#108, Epic #103): only a guest who booked can write one, one per booking: 1–5 stars,
 * their words, the good points (fixed choices), the name and country they show, and a note for
 * the host only. NIHO checks a review before it is published and tells the host first. The host
 * may publish one reply (and correct it later) and report a review to NIHO, but never removes or
 * changes it. NIHO keeps the guest's words as written and its Japanese translation apart; the
 * host writes the reply in Japanese and checks the English that is published.
 * TODO(#87): NIHO's reviews (niho-app#19314) are not in the host contract yet.
 */

/** 公開前 (NIHO is checking it) / 公開中 (on the experience's page). */
export type HostReviewStatus = "pending" | "published";

/** What a guest wrote (the review, or the note to the host): their own words and NIHO's translation, as a guest's message has them. */
export type HostReviewText = Pick<HostGuestMessage, "original" | "language" | "translation">;

/** The host's one public reply: the Japanese they wrote and the English they checked, which is what the page shows. */
export interface HostReviewReply {
  /** Empty when the host wrote the English directly. */
  japanese: string;
  english: string;
  /** YYYY-MM-DDTHH:MM in Japan. */
  publishedAt: string;
  /** The last correction (返信を直す), YYYY-MM-DDTHH:MM in Japan; null when it was never corrected. */
  editedAt: string | null;
}

/** Why the host reported a review to NIHO: 個人情報が書かれている / 事実と違う / 不適切な内容 / その他. */
export type HostReviewReportReason = "personal" | "untrue" | "inappropriate" | "other";

/** The host's report. NIHO decides what happens to the review; it stays as it is meanwhile. */
export interface HostReviewReport {
  /** YYYY-MM-DDTHH:MM in Japan. */
  at: string;
  reason: HostReviewReportReason;
  /** Optional explanation given to NIHO with the reason. */
  note?: string;
}

export interface HostReview {
  id: string;
  experienceId: string;
  /** The booking it was written for: one review per booking, never for one the guest did not come to. */
  bookingId: string;
  /** The session's day (YYYY-MM-DD, JST). */
  sessionDate: string;
  /** What the guest shows: their first name and where they live, in Japanese ("イギリス"). */
  reviewer: { name: string; country: string };
  /** 1–5. */
  rating: number;
  /**
   * よかった点: the identifiers of NIHO's fixed choices (REVIEW_TAGS in reviews.ts has the words the host reads).
   * TODO(#87): NIHO の API（niho-coliving/niho-app#19314）が入ったら識別子を合わせる。
   */
  tags: readonly HostReviewTag[];
  body: HostReviewText;
  /** あなただけへのメモ: for the host only, never published; null when the guest wrote none. */
  privateNote: HostReviewText | null;
  /** YYYY-MM-DDTHH:MM in Japan. */
  writtenAt: string;
  status: HostReviewStatus;
  /** YYYY-MM-DDTHH:MM in Japan; null while NIHO checks it. */
  publishedAt: string | null;
  reply: HostReviewReply | null;
  report: HostReviewReport | null;
}

/**
 * A ledger line's state, in the words of NIHO's provider sales: 計上済み (in the ledger),
 * 入金済み (a payout that reached the bank) and 保留 (not settled yet; a payout on its way
 * reads 送金中).
 */
export type HostSaleStatus = "posted" | "paid" | "pending";

interface HostSaleLine {
  id: string;
  /** YYYY-MM-DD (JST): the day the money moved (the charge, the refund, the payout). */
  date: string;
  status: HostSaleStatus;
  /** Yen, tax included, always positive: `kind` says which way it goes. */
  amountYen: number;
}

/** A guest's payment for a booking (売上). */
export interface HostSaleCharge extends HostSaleLine {
  kind: "sale";
  /** The experience as the ledger names it. */
  experience: string;
  guest: string;
  /** 申込経路: NIHO, NIHO 埋め込み or 体験サイト. */
  channel: string;
  offer: string;
  guests: number;
  /** What NIHO and Stripe keep of the payment (手数料). */
  feeYen: number;
  /** The booking it pays for, when 予約 lists it. */
  bookingId?: string;
}

/** Money given back to a guest (返金). */
export interface HostSaleRefund extends HostSaleLine {
  kind: "refund";
  guest: string;
  channel: string;
  bookingId?: string;
}

/** Money sent from the sales to the host's bank account (口座入金). */
export interface HostSalePayout extends HostSaleLine {
  kind: "payout";
  /** The days of sales it covers (YYYY-MM-DD, JST). */
  from: string;
  to: string;
}

export type HostSale = HostSaleCharge | HostSaleRefund | HostSalePayout;
export type HostSaleKind = HostSale["kind"];

export type PaymentReadinessReason = ExperienceProviderPaymentReadinessReason;

/**
 * Where guests meet, used by every experience unless it says otherwise: NIHO's shape (#89). Only
 * `overview` is shown on the public page; the address, the way there, the map and the entrance
 * reach guests whose booking is confirmed. Unset values are "".
 */
export type HostMeetingDefaults = ExperienceProviderMeetingPoint;

/*
 * カレンダー (#109, Epic #103): the provider's Google Calendar and the bookings feed for other
 * calendars. Sessions that overlap an event of the calendars chosen read as full on the
 * experience site (guests are not told why); confirmed bookings are written to one calendar,
 * one event per booking, and taken away when cancelled. Disconnecting leaves the bookings (and
 * the events written) as they are.
 * TODO(#87): NIHO's ICS feed (niho-app#19316) and Google connection (#19317) are not in the host contract yet.
 */

/** 未接続 / 接続中 / 接続が切れた (the host took NIHO's access away in Google). */
export type HostGoogleCalendarStatus = "disconnected" | "connected" | "revoked";

/** One calendar of the connected Google account. */
export interface HostBusyCalendar {
  id: string;
  /** As Google names it. */
  name: string;
  /** Google's color for it (#rrggbb). Decorative: the name says which one it is. */
  color: string;
  /** Its events close the sessions they overlap. */
  checked: boolean;
  /** NIHO may write bookings to it (a calendar the account owns, not a subscribed one such as holidays). */
  writable: boolean;
}

export interface HostGoogleCalendar {
  status: HostGoogleCalendarStatus;
  /** The Google account's email; null when none is connected. */
  account: string | null;
  /** The account's calendars, as Google lists them; empty while not connected. */
  busyCalendars: readonly HostBusyCalendar[];
  /** 予定がある時間は予約を受け付けない. */
  blockBusy: boolean;
  /** 確定した予約をカレンダーに書き込む. */
  writeBookings: boolean;
  /** The calendar bookings are written to; null until one is chosen. */
  writeCalendarId: string | null;
}

/** What a Google sign-in brings: the account and its calendars (the preview's synthetic one in mock mode). */
export interface HostGoogleConnection {
  account: string;
  calendars: readonly HostBusyCalendar[];
}

export interface HostCalendarSettings {
  google: HostGoogleCalendar;
  /** ほかのカレンダーで見る: the bookings as an .ics feed at an address no one can guess; null when there is none to show. */
  icsUrl: string | null;
}

/*
 * 通知 (#109, Epic #103): v1 sends email only, to the provider's verified addresses. The shape is
 * NIHO's `GET/PATCH /api/experience-providers/{providerId}/notification-settings` (niho-app spec
 * §17.4, OWNER only). Changing the addresses is outside it (#19238).
 */

/** The notifications NIHO sends a provider, in the order NIHO lists them (notifications.ts has the words). */
export type HostNotificationKey = "NEW_BOOKING" | "APPROVAL_DEADLINE" | "CANCELLATION" | "GUEST_MESSAGE" | "DAY_BEFORE_SUMMARY" | "NEW_REVIEW" | "LISTING_REVIEW";

/** One notification as NIHO answers it. `key` stays a string: a key the console does not know yet is left out. */
export interface HostNotificationItem {
  key: string;
  enabled: boolean;
  /** The host cannot turn it off. */
  locked: boolean;
}

export interface HostNotificationSettings {
  email: { addresses: readonly string[] };
  items: readonly HostNotificationItem[];
}

/** The settings screen's starting values. */
export interface HostSettings {
  displayName: string;
  kind: HostProviderKind | null;
  bio: string;
  sellerDisclosureUrl: string;
  reviewStatus: HostProviderReviewStatus | null;
  /** The provider agreed to the version of NIHO's provider terms in force (審査を申請 needs it). */
  consentCurrent: boolean;
  /** 既定の集合案内; null when it could not be read, or for a member NIHO does not show it to (only OWNER and EDITOR). */
  meetingPoint: HostMeetingDefaults | null;
  calendar: HostCalendarSettings;
  /** Null for anyone but the OWNER: NIHO answers the notification settings to the owner only. */
  notifications: HostNotificationSettings | null;
}
