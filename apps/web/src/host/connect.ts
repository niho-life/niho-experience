import "server-only";
import { isStripeConnectUrl, type ExperienceHostApiClient, type ExperienceHostApiFailure } from "@niho-experience/api-client/legacy-host";
import { isHostMock } from "@/lib/host/server";
import { hostFailureMessage } from "./errors";
import type { HostNotice } from "./payout";
import type { PaymentReadinessReason } from "./types";

/*
 * Stripe's account page for a provider's payout account (#88/#91). NIHO hands out a one-time
 * link (connect start / resume) and Stripe sends the host back to 設定 with
 * `?connect=return|refresh`. The only module that loads the host client package at runtime
 * besides src/lib/host (eslint.config.mjs): it checks the link before anyone follows it.
 */

/** Where a step leaves the account: Stripe's page to open, a state read back from NIHO, or a refusal. */
export type StripeStep =
  | { kind: "stripe"; url: string }
  /** `preview`: mock mode, where Stripe's page stands in as finished (see openStripe). */
  | { kind: "state"; reason: PaymentReadinessReason; preview: boolean }
  /** `failure` null: NIHO answered with a link that is not Stripe's. */
  | { kind: "failed"; failure: ExperienceHostApiFailure | null };

/**
 * Starts (the first time) or resumes (a link that expired or was left) Stripe's page. Only a
 * link on Stripe's own origin is followed. In the preview (mock mode) the contract mock's link
 * points nowhere: its sync stands for the host finishing Stripe's page, with the same client,
 * so the screen shows where that leads instead of a dead page.
 */
export async function openStripe(client: ExperienceHostApiClient, providerId: string, step: "start" | "resume"): Promise<StripeStep> {
  const result = step === "start" ? await client.startExperienceProviderPaymentConnect(providerId) : await client.resumeExperienceProviderPaymentConnect(providerId);
  if (!result.ok) return { kind: "failed", failure: result };
  const { url, reason } = result.data;
  if (url && isStripeConnectUrl(url)) return { kind: "stripe", url };
  if (url && isHostMock()) {
    const synced = await client.syncExperienceProviderPaymentConnect(providerId);
    return synced.ok ? { kind: "state", reason: synced.data.reason, preview: true } : { kind: "failed", failure: synced };
  }
  return url ? { kind: "failed", failure: null } : { kind: "state", reason, preview: false };
}

/** Reads the account's state from Stripe again (NIHO saves it): after Stripe's page, or when the host asks. */
export async function syncStripe(client: ExperienceHostApiClient, providerId: string): Promise<StripeStep> {
  const result = await client.syncExperienceProviderPaymentConnect(providerId);
  return result.ok ? { kind: "state", reason: result.data.reason, preview: false } : { kind: "failed", failure: result };
}

export const STRIPE_LINK_UNUSABLE_TEXT = "Stripe の画面を開けませんでした。時間をおいて、もう一度お試しください。";
export const PREVIEW_STRIPE_TEXT = "プレビューでは Stripe の画面を開かず、入力を終えたものとして口座の状態を読み直しました。";
export const STRIPE_SYNCED_TEXT = "口座の状態を Stripe から読み直しました。";

/** A step that stays on this site, in one sentence. */
export function stepNotice(step: Exclude<StripeStep, { kind: "stripe" }>): HostNotice {
  if (step.kind === "failed") return { tone: "error", message: step.failure ? hostFailureMessage(step.failure) : STRIPE_LINK_UNUSABLE_TEXT };
  return { tone: "success", message: step.preview ? PREVIEW_STRIPE_TEXT : STRIPE_SYNCED_TEXT };
}
