import type { ExperienceHostApiFailure, ExperienceHostErrorReason } from "@niho-experience/api-client/legacy-host";

/*
 * What the host reads when NIHO refuses a change (#88/#91): one sentence per `error.details.reason`
 * of the host contract, else by status. NIHO's own message is never shown (it is not written for hosts).
 */

export const HOST_ERROR_REASON_TEXT = {
  PROVIDER_CONSENT_OUTDATED: "提供者規約が新しくなりました。ページを読み込み直して、新しい規約に同意してください。",
  PROVIDER_EMAIL_REQUIRED: "NIHO アカウントにメールアドレスがありません。NIHO アプリでメールアドレスを登録してから、もう一度お試しください。",
  PROVIDER_REVIEW_STATE_CONFLICT: "いまは審査を申請できません。特商法表示 URL（https）と提供者規約の同意を確かめてください。",
  PROVIDER_PAYMENT_SOURCE_FORBIDDEN: "選んだ拠点の口座は使えません。あなたがオーナーで、口座のある拠点を選んでください。",
  PROVIDER_PAYMENT_LOCKED: "申込があるため口座は変更できません。",
  PROVIDER_PAYMENT_CONSENT_OUTDATED: "口座の共有の同意文が新しくなりました。ページを読み込み直して、もう一度同意してください。",
  PROVIDER_PAYMENT_SOURCE_NOT_READY: "選んだ拠点の口座は、まだ準備が済んでいません。準備済みの口座を選んでください。",
  PROVIDER_CONNECT_UNAVAILABLE: "いまは Stripe の口座の接続を使えません。時間をおいて、もう一度お試しください。",
  PROVIDER_PAYMENT_SHARED_ACCOUNT: "拠点の口座を共有しているため、ここでは接続できません。共有している拠点の口座の設定を確かめてください。",
  PROVIDER_PAYMENT_NOT_CONNECTED: "口座がまだ接続されていません。「Stripe で口座を接続」から進めてください。",
} satisfies Partial<Record<ExperienceHostErrorReason, string>>;

export const HOST_NETWORK_ERROR_TEXT = "NIHO に接続できませんでした。時間をおいて、もう一度お試しください。";
export const HOST_SESSION_ENDED_TEXT = "ログインの有効期限が切れました。ページを読み込み直してください。";
export const HOST_INVALID_INPUT_TEXT = "入力を確かめてください。";

type HostErrorReasonWithSpecificText = keyof typeof HOST_ERROR_REASON_TEXT;
const isKnownReason = (reason: string | null): reason is HostErrorReasonWithSpecificText => reason !== null && Object.hasOwn(HOST_ERROR_REASON_TEXT, reason);

/** One sentence for a refused or failed call to NIHO's host API. */
export function hostFailureMessage(failure: ExperienceHostApiFailure): string {
  if (failure.kind === "network_error") return HOST_NETWORK_ERROR_TEXT;
  if (failure.kind === "unexpected_response") return "NIHO から読めない応答がありました。時間をおいて、もう一度お試しください。";
  if (isKnownReason(failure.reason)) return HOST_ERROR_REASON_TEXT[failure.reason];
  if (failure.status === 400) return HOST_INVALID_INPUT_TEXT;
  if (failure.status === 401) return HOST_SESSION_ENDED_TEXT;
  if (failure.status === 403) return "この操作をする権限がありません。提供者のオーナーに依頼してください。";
  if (failure.status === 404) return "提供者が見つかりません。権限が無いか、URL が正しくありません。";
  if (failure.status === 429) return "操作が続いています。少し待ってから、もう一度お試しください。";
  if (failure.status >= 500) return "NIHO で問題が起きました。時間をおいて、もう一度お試しください。";
  return "いまはこの操作ができません。ページを読み込み直してから、もう一度お試しください。";
}
