import type { HostProviderReviewStatus, HostProviderRole } from "@/lib/host/providers";
import { payoutStatus, type StatusLabel } from "./status";
import type { PaymentReadinessReason } from "./types";

/*
 * 売上受取口座 and 提供者の審査 (#88/#91) as the screens show them: what the payout account's
 * state means, what the owner can do next, the note on 売上, and when 審査を申請 can be pressed.
 * Plain data and rules (no server code), shared by the settings and sales pages.
 */

/**
 * Where 「Stripe で確認」 and 「Stripe で入金の明細を見る」 go: Stripe's own sign-in for connected
 * accounts. NIHO's host contract has no per-account login link yet.
 */
export const STRIPE_DASHBOARD_URL = "https://connect.stripe.com/express_login";

/** NIHO's consent for sharing a spot's seller account (its version goes back with the choice). */
export interface PayoutReuseConsent {
  version: string;
  text: string;
}

/** The payout account as the owner sees it. */
export interface HostPayout {
  reason: PaymentReadinessReason;
  /** The spot whose seller account this provider shares, by name; null for its own account (or none yet). */
  sharedFrom: string | null;
  /** Spots of the owner with a ready seller account this provider could share (NIHO's ids and names). */
  candidates: readonly { id: string; name: string }[];
  reuseConsent: PayoutReuseConsent | null;
}

/** What the console could learn about the payout account. NIHO answers only the provider's OWNER. */
export type HostPayoutLoad =
  | { status: "owner"; payout: HostPayout }
  /** An EDITOR (or someone NIHO lets in without a role): the state is the owner's to see. */
  | { status: "not-owner" }
  | { status: "error" };

/** A result to say near the controls: role=status for success, role=alert for errors. */
export interface HostNotice {
  tone: "success" | "error";
  message: string;
}

/** What a server action answers (src/host/actions.ts): the outcome in one sentence, and on success what changed. */
export type HostActionResult<T extends object = object> = ({ ok: true; message: string } & T) | { ok: false; message: string };

/** 提供者の登録 as the form sends it; `consentVersion` is the version of the terms the host agreed to. */
export interface RegisterProviderInput {
  kind: string;
  displayName: string;
  bio: string;
  consentVersion: string;
}

/** 提供者情報 as NIHO keeps it. */
export interface ProviderProfile {
  displayName: string;
  bio: string;
}

/** 保存 of 提供者情報: the provider and only the fields that changed. */
export type ProviderProfileChange = { providerId: string } & Partial<ProviderProfile>;

export const READINESS_TEXT: Record<PaymentReadinessReason, string> = {
  NOT_CONNECTED: "売上を受け取る口座を接続してください。",
  VERIFICATION_REQUIRED: "Stripe で本人確認の続きを入力してください。",
  CHARGES_DISABLED: "決済を受け付けるための確認が必要です。Stripe で状態を確かめてください。",
  PAYOUTS_DISABLED: "売上の受け取りに確認が必要です。Stripe で状態を確かめてください。",
  RESTRICTED: "口座の利用条件を Stripe で確かめてください。",
  READY: "売上を受け取る準備ができています。",
};

export const PAYOUT_OWNER_ONLY_TEXT = "口座の状態はオーナーが確認できます";
export const PAYOUT_UNREADABLE_TEXT = "口座の状態を読み込めませんでした。時間をおいて、ページを読み込み直してください。";

/** What the owner can do with the account: share a spot's account, open Stripe's page (first time / to continue), or read the state again. */
export type PayoutAction = "share" | "connect" | "resume" | "sync";

export interface PayoutPanelView {
  /** The pill beside 売上受取口座; null when the state is not this person's to see. */
  status: StatusLabel | null;
  /** The account in words: "サンプルの拠点の口座を共有中", or what is still needed. */
  text: string;
  actions: readonly PayoutAction[];
  /** 「Stripe で確認」 beside a ready account. */
  dashboard: boolean;
}

/** 設定 › 売上受取口座 for this payout state. `displayName` names the provider's own account. */
export function payoutPanelView(load: HostPayoutLoad, displayName: string): PayoutPanelView {
  if (load.status === "not-owner") return { status: null, text: PAYOUT_OWNER_ONLY_TEXT, actions: [], dashboard: false };
  if (load.status === "error") return { status: null, text: PAYOUT_UNREADABLE_TEXT, actions: [], dashboard: false };
  const { reason, sharedFrom, candidates, reuseConsent } = load.payout;
  const status = payoutStatus(reason);
  if (reason === "READY") return { status, text: sharedFrom ? `${sharedFrom}の口座を共有中` : `${displayName.trim() || "提供者"}の口座`, actions: [], dashboard: true };
  // A shared account is set up on its spot: NIHO refuses to connect or sync it here.
  if (sharedFrom) return { status, text: `${READINESS_TEXT[reason]}共有している${sharedFrom}の口座の設定を確かめてください。`, actions: [], dashboard: false };
  if (reason === "NOT_CONNECTED") return { status, text: READINESS_TEXT[reason], actions: candidates.length > 0 && reuseConsent ? ["connect", "share"] : ["connect"], dashboard: false };
  if (reason === "VERIFICATION_REQUIRED") return { status, text: READINESS_TEXT[reason], actions: ["resume", "sync"], dashboard: false };
  return { status, text: READINESS_TEXT[reason], actions: ["sync"], dashboard: false };
}

/** The note above 売上 when the money cannot reach the host yet; null when the account is ready. */
export type SalesPayoutNotice =
  | { kind: "setup"; title: string; text: string }
  | { kind: "owner-only"; text: string }
  | { kind: "unknown"; text: string };

export function salesPayoutNotice(load: HostPayoutLoad): SalesPayoutNotice | null {
  if (load.status === "not-owner") return { kind: "owner-only", text: PAYOUT_OWNER_ONLY_TEXT };
  if (load.status === "error") return { kind: "unknown", text: "受取口座の状態を読み込めませんでした。" };
  if (load.payout.reason === "READY") return null;
  return { kind: "setup", title: "受取口座の設定が済んでいません", text: READINESS_TEXT[load.payout.reason] };
}

export interface ReviewState {
  reviewStatus: HostProviderReviewStatus | null;
  role: HostProviderRole | null;
  /** Changes on screen that are not saved yet. */
  unsaved: boolean;
  payoutReady: boolean;
  consentCurrent: boolean;
}

/** The 審査 row of 提供者情報: 審査を申請 (with why it waits, if it does) or a line about where the review stands. */
export type ReviewRow = { kind: "submit"; blocker: string | null } | { kind: "note"; text: string };

/**
 * Only a provider not submitted yet (未申請) has 審査を申請, and only its owner can press it: once
 * the changes are saved, the payout account is ready. NIHO
 * checks the consent too, and answers 409 otherwise. Null: nothing to say
 * (審査済み, or a state the console does not know).
 */
export function reviewRow(state: ReviewState): ReviewRow | null {
  if (state.reviewStatus === "REQUESTED") return { kind: "note", text: "NIHO が確認しています。" };
  if (state.reviewStatus === "SUSPENDED") return { kind: "note", text: "提供者情報を直して保存すると、NIHO がもう一度審査します。" };
  if (state.reviewStatus !== "DRAFT") return null;
  if (state.role !== "OWNER") return { kind: "note", text: "審査の申請はオーナーが行います。" };
  return { kind: "submit", blocker: reviewSubmitBlocker(state) };
}

function reviewSubmitBlocker(state: ReviewState): string | null {
  if (state.unsaved) return "変更を保存すると申請できます。";
  if (!state.payoutReady) return "売上受取口座の準備ができると申請できます。";
  if (!state.consentCurrent) return "提供者規約への同意が古いため申請できません。NIHO にお問い合わせください。";
  return null;
}

/** Saving 提供者情報 sends a reviewed provider back to NIHO's review (and pauses its live experiences): ask first. */
export function saveNeedsReviewConfirm(reviewStatus: HostProviderReviewStatus | null): boolean {
  return reviewStatus === "APPROVED" || reviewStatus === "SUSPENDED";
}
