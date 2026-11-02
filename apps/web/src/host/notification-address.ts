/*
 * 設定 › 通知 › 宛先 (#194, owner decision 2026-11-01): where this site emails the signed-in person. Existing verified
 * login addresses are retained; with the current app-connect token, an OWNER can enter and verify a new address by email.
 * Plain data and words (no server code), shared by the settings page, its panel and the server actions.
 */

/** 宛先 as the panel shows it. */
export interface HostNotificationAddressView {
  /** Where the emails go now, or null (no sign-in copy yet, and nothing chosen). */
  effective: string | null;
  /** Why: the sign-in's verified address, or the one the person chose. */
  source: "login" | "chosen" | null;
  /** The sign-in's address, when there is one (for 「ログインのメールに戻す」). */
  login: string | null;
  /** An address waiting for its link to be opened. */
  pending: string | null;
  /** The preview (mock mode): changes stay on this screen and nothing is sent. */
  preview: boolean;
}

export const NOTIFICATION_ADDRESS_TEXT = {
  login: "以前に確認したNIHOアカウントのメールです。",
  chosen: "あなたが設定したメールです。",
  none: "まだ宛先がありません。メールアドレスを入力して確認すると、予約などの通知を受け取れます。",
  pending: (address: string) => `${address} に確認のメールを送りました。メールのリンクを開くと、宛先がこのアドレスに変わります（1 時間有効）。`,
  previewPending: (address: string) => `${address} に確認のメールを送ります（プレビューでは送りません）。`,
  sent: "確認のメールを送りました。",
  cancelled: "確認を取り消しました。",
  backToLogin: "ログインのメールに戻しました。",
  unchanged: "このアドレスに届いています。",
  invalid: "メールアドレスの形を確かめてください。",
  rateLimited: "確認のメールを送れるのは 1 時間に 5 回までです。時間をおいてお試しください。",
  failed: "宛先を変えられませんでした。時間をおいて、もう一度お試しください。",
  loadFailed: "宛先を読み込めませんでした。時間をおいて、ページを読み込み直してください。",
} as const;

const EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;

/** The address the person typed, trimmed, or null unless it has the shape the store accepts. */
export function notificationAddressInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 254 && EMAIL.test(trimmed) ? trimmed : null;
}

/** The store's answer as the panel's view. */
export function notificationAddressView(
  address: { loginEmail: string | null; overrideEmail: string | null; effectiveEmail: string | null; pendingEmail: string | null },
  preview = false,
): HostNotificationAddressView {
  return {
    effective: address.effectiveEmail,
    source: address.overrideEmail ? "chosen" : address.loginEmail ? "login" : null,
    login: address.loginEmail,
    pending: address.pendingEmail,
    preview,
  };
}

/** The preview's 宛先 (mock mode): the synthetic account's address as the sign-in's, changed on screen only. */
export function previewNotificationAddress(login: string | null): HostNotificationAddressView {
  return { effective: login, source: login ? "login" : null, login, pending: null, preview: true };
}

/** The line under the address: where it came from. */
export function notificationAddressSourceText(view: HostNotificationAddressView): string {
  return view.source === "chosen" ? NOTIFICATION_ADDRESS_TEXT.chosen : view.source === "login" ? NOTIFICATION_ADDRESS_TEXT.login : NOTIFICATION_ADDRESS_TEXT.none;
}
