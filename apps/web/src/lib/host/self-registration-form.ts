/*
 * 登録画面 (/host/start, Epic #700, #708) のうち、画面に依存しない決まり: 掲載名の初期値、API のエラー code と画面の言葉。
 * ブラウザの部品とサーバーの API の両方が読むので、何も import しない（node:*・store・server-only は置かない）。
 */

export type RegistrationKind = "PERSON" | "BUSINESS";

/** 掲載名（日本語・英語）の長さの上限。store の上限（300）より小さく、画面と API で同じにする。 */
export const REGISTRATION_NAME_MAX = 100;
export const REGISTRATION_EMAIL_MAX = 254;

/**
 * 掲載名の入れ方: 個人のときだけ NIHO の表示名を初期値にし、会社・お店のときは空欄から。ホストが書き換えた値（`edited`）は、
 * 種別を切り替えても消さない。
 */
export function nameAfterKindChange(kind: RegistrationKind, nihoName: string | null, current: { readonly name: string; readonly edited: boolean }): string {
  if (current.edited) return current.name;
  return kind === "PERSON" ? nihoName ?? "" : "";
}

export type RegistrationErrorCode =
  | "INVALID_INPUT"
  | "PUBLIC_NAME_INVALID"
  | "PUBLIC_NAME_RESERVED"
  | "EMAIL_INVALID"
  | "TERMS_REQUIRED"
  | "OWNER_LIMIT_REACHED"
  | "ACCOUNT_SUSPENDED"
  | "ALREADY_REGISTERED"
  | "REGISTRATION_EXPIRED"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "UNAVAILABLE";

/** Which field of the form a code is about (the message goes under it); the others go above the button. */
export type RegistrationErrorField = "name" | "nameEn" | "email" | "terms";

export interface RegistrationErrorDetails {
  readonly field?: RegistrationErrorField;
  readonly limit?: number;
}

export function registrationErrorMessage(code: RegistrationErrorCode, details: RegistrationErrorDetails = {}): string {
  switch (code) {
    case "PUBLIC_NAME_INVALID": return `名前は 1〜${REGISTRATION_NAME_MAX} 文字で、前後に空白を入れずに入力してください。`;
    case "PUBLIC_NAME_RESERVED": return "この名前は使えません。NIHO や事務局を名乗る名前は載せられません。";
    case "EMAIL_INVALID": return "メールアドレスの形を確かめて、もう一度入力してください。";
    case "TERMS_REQUIRED": return "ホスト規約への同意が必要です。";
    case "OWNER_LIMIT_REACHED": return `登録できるホストは、1 つの NIHO アカウントにつき ${details.limit ?? 3} つまでです。`;
    case "ACCOUNT_SUSPENDED": return "このアカウントは停止されています。運営にお問い合わせください。";
    case "ALREADY_REGISTERED": return "この NIHO アカウントは、すでにホストに登録されています。ログインして続けてください。";
    case "REGISTRATION_EXPIRED": return "登録の手続きが時間切れになりました（30 分）。もう一度、NIHO アカウントでログインしてください。";
    case "RATE_LIMITED": return "確認のメールを続けて送れません。少し時間をおいて、もう一度お試しください。入力はそのまま残っています。";
    case "FORBIDDEN": return "この画面から送られた操作ではないため、受け付けませんでした。画面を開き直してください。";
    case "INVALID_INPUT": return "入力を確かめて、もう一度お試しください。";
    case "UNAVAILABLE": return "いまは登録できません。時間をおいて、もう一度お試しください。入力はそのまま残っています。";
  }
}

/** The API's error codes this screen knows; anything else reads as UNAVAILABLE. */
export function registrationErrorCodeOrNull(value: unknown): RegistrationErrorCode | null {
  const known: readonly string[] = ["INVALID_INPUT", "PUBLIC_NAME_INVALID", "PUBLIC_NAME_RESERVED", "EMAIL_INVALID", "TERMS_REQUIRED", "OWNER_LIMIT_REACHED", "ACCOUNT_SUSPENDED", "ALREADY_REGISTERED", "REGISTRATION_EXPIRED", "RATE_LIMITED", "FORBIDDEN", "UNAVAILABLE"];
  return typeof value === "string" && known.includes(value) ? (value as RegistrationErrorCode) : null;
}
