/**
 * 旅行者の一周（Epic #103）の仮契約。NIHO 側の契約にまだ無い項目・操作を、画面を先に作れるよう型と mock だけで持つ。
 *
 * - NIHO が書き出した `contract/experience-public-api.openapi.json` には含まれない。`EXPERIENCE_API_MODE=http` の実 API には繋がず、
 *   画面は mock のときだけこの機能を出す（実 API に無い機能を動いているように見せない）。
 * - 対応する NIHO 側の Issue：参加の条件 niho-coliving/niho-app#19318、予約前の質問 #19319、
 *   当日の連絡用の電話番号 #19311・#19321、メール未着からの復帰 #19241。
 * - 参加の条件・同意・電話番号・決済後の戻り先は niho-coliving/niho-app#19335 に下書きの契約（公開契約 1.4.0・詳細は
 *   `GET /api/public/experiences/v1.4/{experienceSlug}` の `conditions`）があり、下の型と限度はそれに合わせてある。
 *   版が他の PR（#19330 の電話番号、#19168 の v1.2 一覧）と重なっているので、NIHO 側で版が決まって main に入ってから契約を写す。
 * - 体験の FAQ（`faq`・#146）は NIHO 側にまだ Issue も契約も無い。公開 API へ質問と答えの配列を足す依頼を連携A（担当2）から
 *   NIHO 側へ出す必要がある（ホスト紹介文 `hosts[].bio` は v1.1 の契約に既にある）。それまでは mock だけが合成の FAQ を返し、
 *   実 API の配備では節を出さない。
 * - 契約が出たら、この型を生成された型の別名へ置き換え、`fixtures/journey.ts` と mock の経路を消す。
 *   画面は `JourneyDetailExtras` を作る 1 か所（apps/web の `lib/journey.ts`）だけが契約の形を知る。
 */
import type { ExperienceDetailV11 } from "./types.ts";

/** 体験の「参加の条件」の種類。1 つの体験に各種類は最大 1 行。 */
export const EXPERIENCE_CONDITION_KINDS = ["AGE", "PHYSICAL", "HOST_LANGUAGE", "FOOD", "ACCESS", "WEATHER"] as const;
export type ExperienceConditionKind = (typeof EXPERIENCE_CONDITION_KINDS)[number];

/**
 * 参加の条件の 1 行。文言は NIHO が体験の言語で組んだもので、画面は文を組み立てない（翻訳は原文を保って別に持つ：#19244 の規則）。
 */
export type ExperienceConditionItem = {
  kind: ExperienceConditionKind;
  /** 要点の 1 行（太字）。例：`Ages 10 and up` */
  headline: string;
  /** 補足（小さな字）。無ければ null。例：`Children must join with an adult` */
  detail: string | null;
  /** 予約入力の「Before you book」で同意を取る文。null は表示だけで、同意の対象にしない。 */
  consentText: string | null;
};

export type ExperienceConditions = {
  /** 同意した内容の版（項目の文の SHA-256・小文字 16 進 64 字）。予約の記録に残る。条件の文言が変わると変わる。 */
  version: string;
  items: ExperienceConditionItem[];
};

/** 下書きの契約（#19335）の限度。`versionMaxLength` は checkout の `conditionsConsent.version` の上限。 */
export const EXPERIENCE_CONDITION_LIMITS = {
  maxItems: EXPERIENCE_CONDITION_KINDS.length,
  headlineMaxLength: 120,
  detailMaxLength: 300,
  consentTextMaxLength: 300,
  versionMaxLength: 100,
} as const;

/** 同意した条件の版（項目の文の SHA-256・小文字 16 進 64 字）。 */
export const CONDITIONS_VERSION_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 参加の条件つきの詳細（下書きの契約 1.4.0・`GET /api/public/experiences/v1.4/{experienceSlug}`）。v1.1 の詳細に `conditions` を足したもので、
 * 条件の無い体験は null。予約入力が「条件が変わった」と知らされたときの読み直しにも使う。
 */
export type ExperienceDetailV14 = ExperienceDetailV11 & { conditions: ExperienceConditions | null };
export type ExperienceDetailResponseV14 = { experience: ExperienceDetailV14 };

/** 詳細・予約入力の画面へ渡す、契約の外にある（まだ契約に無い）追加の表示データ。 */
export type JourneyDetailExtras = {
  /** この配備が追加項目（条件・質問・電話番号）を提供しているか。false なら画面は新しい部品を一切出さない。 */
  enabled: boolean;
  conditions: ExperienceConditions | null;
  /** 予約前の質問（Ask the host）を受け付けているか。 */
  questionsOpen: boolean;
  /** レビュー。null はこの配備にレビューの機能が無い（"New" の印も節も出さない）。 */
  reviews: JourneyReviews | null;
  /** よくある質問（{@link usableFaq} を通したもの）。空なら節を出さない。 */
  faq: ExperienceFaqItem[];
};

/** 実 API に無い間の値。画面は新しい部品を出さない。 */
export const NO_JOURNEY_EXTRAS: JourneyDetailExtras = { enabled: false, conditions: null, questionsOpen: false, reviews: null, faq: [] };

/* ---------- よくある質問（#146・NIHO 側の契約は未依頼：連携A） ---------- */

/** 体験の FAQ の 1 問。文はホスト・NIHO が書いた体験の言語のもので、画面は組み立てない。どちらも書式なしの文。 */
export type ExperienceFaqItem = { question: string; answer: string };

/** 案の上限。質問は見出し（h3）になるので短く、答えは数段落まで。 */
export const EXPERIENCE_FAQ_LIMITS = { maxItems: 30, questionMaxLength: 200, answerMaxLength: 1200 } as const;

/**
 * 画面に出せる FAQ。前後の空白を落とし、空・上限を超える問い（途中で切った文は見せない）と同じ質問の 2 回目を除き、
 * 先頭から上限の件数までにする。読めない形（配列でない・文字列でない）は空として扱う。
 */
export function usableFaq(faq: readonly unknown[] | null | undefined): ExperienceFaqItem[] {
  if (!Array.isArray(faq)) return [];
  const items: ExperienceFaqItem[] = [];
  const seen = new Set<string>();
  for (const entry of faq) {
    if (items.length === EXPERIENCE_FAQ_LIMITS.maxItems) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { question, answer } = entry as Record<string, unknown>;
    if (typeof question !== "string" || typeof answer !== "string") continue;
    const q = question.trim();
    const a = answer.trim();
    if (!q || !a || q.length > EXPERIENCE_FAQ_LIMITS.questionMaxLength || a.length > EXPERIENCE_FAQ_LIMITS.answerMaxLength) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ question: q, answer: a });
  }
  return items;
}

/** 同意の対象にする条件の文（`consentText`）。空なら「Before you book」は出さない。 */
export function conditionConsentTexts(conditions: ExperienceConditions | null): string[] {
  return conditions ? conditions.items.flatMap((item) => (item.consentText ? [item.consentText] : [])) : [];
}

/** 画面に出せる条件か。項目が 1 つも無い・版が空のものは「条件なし」として扱う。 */
export function usableConditions(conditions: ExperienceConditions | null | undefined): ExperienceConditions | null {
  if (!conditions || !conditions.version || conditions.items.length === 0) return null;
  return conditions;
}

/* ---------- 予約前の質問（Ask the host） ---------- */

export const ASK_HOST_TOPICS = ["CHILDREN", "FOOD", "ACCESS", "LANGUAGE", "OTHER"] as const;
export type AskHostTopic = (typeof ASK_HOST_TOPICS)[number];

export const ASK_HOST_INPUT_LIMITS = {
  messageMinLength: 5,
  messageMaxLength: 1000,
  guestNameMaxLength: 100,
  guestEmailMaxLength: 254,
  clientRequestKeyMinLength: 8,
  clientRequestKeyMaxLength: 120,
} as const;

/** `POST /api/public/experiences/{slug}/questions` の要求。旅行者のブラウザから NIHO へ直接送る。 */
export type AskHostRequest = {
  topic: AskHostTopic;
  message: string;
  guestName: string;
  guestEmail: string;
  clientRequestKey: string;
};

export type AskHostErrorCode = "VALIDATION_ERROR" | "INPUT_INVALID" | "UNAVAILABLE" | "RATE_LIMITED" | "SEND_FAILED";
export type AskHostError = {
  code: AskHostErrorCode;
  message: string;
  retryable: boolean;
  /** `INPUT_INVALID` のとき、直す項目（`message` / `guestName` / `guestEmail` / `topic`）。 */
  field: string | null;
};

export type AskHostResult =
  | { ok: true }
  | { ok: false; kind: "rejected"; status: number; error: AskHostError; retryAfterSeconds: number | null }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 送信前の確認（画面と mock が同じ規則を使う）。直す項目の名前を返す。 */
export function askHostInputProblem(request: Pick<AskHostRequest, "topic" | "message" | "guestName" | "guestEmail">): "topic" | "message" | "guestName" | "guestEmail" | null {
  if (!ASK_HOST_TOPICS.includes(request.topic)) return "topic";
  const message = request.message.trim();
  if (message.length < ASK_HOST_INPUT_LIMITS.messageMinLength || message.length > ASK_HOST_INPUT_LIMITS.messageMaxLength) return "message";
  const name = request.guestName.trim();
  if (name.length === 0 || name.length > ASK_HOST_INPUT_LIMITS.guestNameMaxLength) return "guestName";
  const email = request.guestEmail.trim();
  if (!EMAIL_PATTERN.test(email) || email.length > ASK_HOST_INPUT_LIMITS.guestEmailMaxLength) return "guestEmail";
  return null;
}

/* ---------- 予約入力の追加項目（checkout の要求に加わる予定の任意項目） ---------- */

/** 当日の連絡用の電話番号（任意）と、参加の条件への同意の版。契約が出るまでは mock の checkout だけが受ける。 */
export type ExperienceCheckoutJourneyFields = {
  guestPhone?: string;
  conditionsConsent?: { version: string };
};

export const GUEST_PHONE_LIMITS = { maxLength: 24, minDigits: 7, maxDigits: 15 } as const;

const GUEST_PHONE_PATTERN = /^\+?[0-9 ().-]+$/;

/** 前後の空白を落とし、続く空白を 1 つにする（NIHO の `normalizeSpotCampaignPageGuestPhone` と同じ。整形や国番号の補完はしない）。 */
export function normalizeGuestPhone(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * 任意の電話番号。国番号つき・なしのどちらも受け、整形はしない（正規化した後で 24 字まで・数字が 7〜15 桁・`+` は先頭だけ・
 * ほかは数字と空白と `()-.` だけ）。サーバーが同じ規則で確かめ直す。
 */
export function isValidGuestPhone(value: string): boolean {
  const text = normalizeGuestPhone(value);
  if (text.length === 0 || text.length > GUEST_PHONE_LIMITS.maxLength) return false;
  if (!GUEST_PHONE_PATTERN.test(text)) return false;
  const digits = text.replace(/[^0-9]/g, "").length;
  return digits >= GUEST_PHONE_LIMITS.minDigits && digits <= GUEST_PHONE_LIMITS.maxDigits;
}

/* ---------- レビュー（niho-coliving/niho-app#19314） ---------- */

/** 平均は 3 件から出す（owner 決定 2026-10-22）。2 件以下は件数と本文だけを見せる。 */
export const REVIEW_AVERAGE_MIN_COUNT = 3;

export const REVIEW_LIMITS = { bodyMaxLength: 2000, tagMaxLength: 40, displayNameMaxLength: 60, listMaxItems: 50 } as const;

export type ExperienceReviewReply = { hostName: string; body: string };

/**
 * 公開してよいレビュー 1 件。予約者だけが書き、NIHO が確認してから公開する（owner 決定 2026-10-22）。
 * 表示名は「名＋国・地域」で、姓・メール・予約の識別子は含めない。
 */
export type ExperienceReview = {
  /** 一覧の key に使う不透明な識別子。予約・利用者の ID ではない。 */
  id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  body: string;
  /** よかった点（固定の選択肢の表示名）。 */
  tags: string[];
  displayName: string;
  originLabel: string | null;
  /** 公開した日時（ISO 8601）。新しい順の並びと、構造化データの datePublished に使う。 */
  publishedAt: string;
  /** 予約を経由して書かれたレビューか（"Booked on NIHO" の印）。v1 は全件が true の想定。 */
  fromBooking: boolean;
  /** 提供者の返信（1 つだけ）。 */
  reply: ExperienceReviewReply | null;
};

export type ExperienceReviewTagCount = { label: string; count: number };
/** 体験ごとの集計。`average` は 1.0〜5.0（件数 0 のとき null）。表示するかどうかは画面の規則（3 件から）。 */
export type ExperienceReviewSummary = { count: number; average: number | null; tags: ExperienceReviewTagCount[] };

/** `GET /api/public/experiences/{experienceSlug}/reviews?limit=` の応答。`reviews` は新しい順。 */
export type ExperienceReviewsResponse = { summary: ExperienceReviewSummary; reviews: ExperienceReview[] };

/** 詳細の画面へ渡すレビュー。`unavailable` は読めなかったとき（件数 0 とは別）。 */
export type JourneyReviews = { status: "ok"; summary: ExperienceReviewSummary; items: ExperienceReview[] } | { status: "unavailable" };
