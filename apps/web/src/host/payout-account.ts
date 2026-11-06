import type { ConnectedAccountProblem } from "@niho-experience/experience-payments";
import type { HostPayoutLoad } from "./payout";
import type { StatusLabel } from "./status";
import type { PaymentReadinessReason } from "./types";

/*
 * 設定 › 受取口座 with Experience host accounts (ADR 0003 slice 3, docs/host-accounts.md): the provider's registered Stripe
 * account as Stripe reports it, and the OWNER's consent to receive the provider's Experience sales in it. Plain data
 * and wording (no server code), shared by 設定, 売上 and the consent route.
 */

/** What the console learnt about the payout account with an Experience host account. */
export type ExperiencePayoutLoad =
  | { readonly status: "not-owner" }
  /** Admin/ops have not registered the provider's seller and account yet. */
  | { readonly status: "setup-required" }
  | { readonly status: "error" }
  | {
    readonly status: "owner";
    readonly providerName: string;
    readonly accountLast4: string;
    /** `unknown`: Stripe could not be asked now. `unreachable`: Stripe does not show the account to this platform. */
    readonly stripe: "ready" | "not_ready" | "unreachable" | "unknown";
    readonly problems: readonly ConnectedAccountProblem[];
    /** `unknown` when it could not be read now (the forms are not shown then). */
    readonly consent:
      | { readonly state: "current"; readonly consentedAtUtc: string }
      | { readonly state: "outdated" | "none" | "unknown" };
    /** The version the OWNER agrees to now; empty while none is configured (the consent cannot be given then). */
    readonly consentVersion: string;
  };

/** Stripe's reasons in plain words, in the order they are listed. */
export const PAYOUT_ACCOUNT_PROBLEM_TEXT: Readonly<Record<ConnectedAccountProblem, string>> = {
  DETAILS_NOT_SUBMITTED: "Stripe への登録情報（事業者の情報・本人確認・振込先の銀行口座）に、まだ入力されていないものがあります。",
  CHARGES_DISABLED: "Stripe で、決済の受け付けが止まっています。",
  PAYOUTS_DISABLED: "Stripe で、銀行口座への入金が止まっています。",
  NOT_JAPAN: "口座の国が日本ではありません。この販売で使えるのは日本の口座だけです。",
  NOT_JPY: "口座の通貨が日本円ではありません。この販売で使えるのは日本円の口座だけです。",
};

export const PAYOUT_ACCOUNT_TEXT = {
  ready: "売上を受け取る準備ができています。",
  unreachable: "Stripe でこの口座を確認できません（この販売の仕組みにつながっていない口座です）。運営にお問い合わせください。",
  unknown: "Stripe から口座の状態を読み込めませんでした。時間をおいて、ページを読み込み直してください。",
  setupRequired: "受取口座がまだ登録されていません。運営が事業者と口座を確認して登録します。運営にお問い合わせください。",
  ownerOnly: "受取口座はオーナーが確認できます",
  unreadable: "受取口座を読み込めませんでした。時間をおいて、ページを読み込み直してください。",
  consentCurrent: "この口座で売上を受け取ることに同意しています。",
  consentNone: "この口座で売上を受け取ることへの同意が、まだありません。同意すると体験を公開できます。",
  consentOutdated: "同意の内容が変わりました。新しい内容を確認して、もう一度同意してください。それまで、新しい公開と公開の再開はできません。",
  consentUnavailable: "同意の受付は準備中です。",
  recentSignIn: "同意と取り消しには、30 分以内のログインが必要です。古いときは、ログインし直してから戻ります。",
  withdrawWarning: "取り消すと、公開中の体験はすべて止まり、新しい公開と販売はできなくなります。すでに入った予約はそのままです。",
} as const;

/**
 * The consent the OWNER gives, at the configured version (EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION). Draft wording in
 * docs/host-accounts.md, waiting for the owner's approval; a change of this text needs a new version.
 */
export function payoutAccountConsentText(input: { readonly providerName: string; readonly accountLast4: string }): string {
  const name = input.providerName.trim() || "この提供者";
  return `${name}が NIHO Experience で販売する体験の売上は、Stripe の口座（末尾 ${input.accountLast4}）で受け取ります。`
    + "売上からは、販売条件に示す Stripe の決済手数料と NIHO の手数料が差し引かれます。"
    + "この同意を取り消すと、公開中の体験は止まり、新しい公開と販売はできなくなります。";
}

/** The pill beside 受取口座. */
export function experiencePayoutStatus(load: ExperiencePayoutLoad): StatusLabel | null {
  if (load.status === "setup-required") return { label: "未登録", tone: "wait" };
  if (load.status !== "owner") return null;
  if (load.stripe !== "ready") return { label: "確認が必要", tone: "wait" };
  return load.consent.state === "current" ? { label: "準備済み", tone: "ok" } : { label: "同意が必要", tone: "wait" };
}

/** What Stripe says of the account, one sentence each. */
export function experiencePayoutLines(load: Extract<ExperiencePayoutLoad, { status: "owner" }>): readonly string[] {
  if (load.stripe === "ready") return [PAYOUT_ACCOUNT_TEXT.ready];
  if (load.stripe === "unreachable") return [PAYOUT_ACCOUNT_TEXT.unreachable];
  if (load.stripe === "unknown") return [PAYOUT_ACCOUNT_TEXT.unknown];
  return (Object.keys(PAYOUT_ACCOUNT_PROBLEM_TEXT) as ConnectedAccountProblem[])
    .filter((problem) => load.problems.includes(problem))
    .map((problem) => PAYOUT_ACCOUNT_PROBLEM_TEXT[problem]);
}

/** Stripe's answer as the older readiness reasons, for 売上's note and 設定's review row. */
function reasonOf(load: Extract<ExperiencePayoutLoad, { status: "owner" }>): PaymentReadinessReason | null {
  if (load.stripe === "ready") return "READY";
  if (load.stripe === "unknown") return null;
  if (load.stripe === "unreachable") return "RESTRICTED";
  if (load.problems.includes("DETAILS_NOT_SUBMITTED")) return "VERIFICATION_REQUIRED";
  if (load.problems.includes("CHARGES_DISABLED")) return "CHARGES_DISABLED";
  if (load.problems.includes("PAYOUTS_DISABLED")) return "PAYOUTS_DISABLED";
  return "RESTRICTED";
}

/** The same account as the console's other payout panels and notes read it (売上's note, 設定's review row). */
export function hostPayoutLoadOf(load: ExperiencePayoutLoad): HostPayoutLoad {
  if (load.status === "not-owner") return { status: "not-owner" };
  if (load.status === "setup-required") return { status: "owner", payout: { reason: "NOT_CONNECTED", sharedFrom: null, candidates: [], reuseConsent: null } };
  if (load.status === "error") return { status: "error" };
  const reason = reasonOf(load);
  return reason === null ? { status: "error" } : { status: "owner", payout: { reason, sharedFrom: null, candidates: [], reuseConsent: null } };
}

/** `?payout=` after the consent form: what happened, said near the form. */
export const PAYOUT_CONSENT_OUTCOMES = {
  consented: { tone: "success", message: "同意を記録しました。" },
  withdrawn: { tone: "success", message: "同意を取り消しました。公開中だった体験は止めました。" },
  unchecked: { tone: "error", message: "同意の内容を確認して、チェックを入れてから押してください。" },
  changed: { tone: "error", message: "受取口座または同意の内容が変わりました。表示し直した内容を確認してください。" },
  forbidden: { tone: "error", message: "この操作は、提供者のオーナーだけができます。" },
  unavailable: { tone: "error", message: "記録できませんでした。時間をおいて、もう一度お試しください。" },
} as const satisfies Record<string, { tone: "success" | "error"; message: string }>;

export type PayoutConsentOutcome = keyof typeof PAYOUT_CONSENT_OUTCOMES;

export function payoutConsentOutcomeOrNull(value: unknown): PayoutConsentOutcome | null {
  return typeof value === "string" && Object.hasOwn(PAYOUT_CONSENT_OUTCOMES, value) ? value as PayoutConsentOutcome : null;
}
