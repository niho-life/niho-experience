import {
  createAccountOnboardingLink,
  createDirectAccount,
  directAccountCreationParams,
  findPayoutAccountByCreationId,
  PAYOUT_ACCOUNT_IDEMPOTENCY_WINDOW_MS,
  retrieveDirectAccountStatus,
  type DirectAccountCreationParams,
} from "@niho-experience/experience-payments";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  type ConnectAccountRecord,
  type ConnectAccountState,
  type HostActor,
  type ProviderDirectSellers,
} from "@niho-experience/experience-store";
import { randomUUID } from "node:crypto";
import type { PayoutOnboardingDeps } from "./host-connect-onboarding";

/*
 * ホストが自分の Stripe アカウントをつなぐ (Epic #700 stage 3c-1, #726, docs/host-payouts.md「3c」): the same flow as the payout
 * account's (host-connect-onboarding.ts: reserve the row, create the account, record its ID once, give the Account Link), for a
 * full-dashboard account the host signs in to; then, once Stripe says READY, the seller profile and the payout-account consent.
 * Nothing here logs, stores or returns an Account Link URL except to the caller that redirects to it at once.
 */

export interface DirectAccountDeps extends PayoutOnboardingDeps {
  readonly sellers?: Pick<ProviderDirectSellers, "register">;
}

/** What went wrong, in the words 設定 › 受取口座 says near the button (`?payout=`). */
export type DirectAccountFailure =
  | "directForbidden" | "directSeller" | "directUnavailable" | "directReview" | "directNotStarted" | "directNotReady" | "directDisclosure" | "directProfile" | "directChanged";

export type DirectOnboardingResult =
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "failed"; readonly outcome: DirectAccountFailure };

const stripeOptions = (deps: PayoutOnboardingDeps) => (deps.stripe ? { stripe: deps.stripe } : { platformStripeKey: deps.platformStripeKey });

function returnUrls(deps: PayoutOnboardingDeps, providerId: string): { returnUrl: string; refreshUrl: string } {
  const settings = new URL("/host/settings", deps.siteOrigin);
  settings.searchParams.set("providerId", providerId);
  settings.searchParams.set("connect", "return");
  const refresh = new URL("/host/api/direct-account/onboarding/refresh", deps.siteOrigin);
  refresh.searchParams.set("providerId", providerId);
  return { returnUrl: settings.href, refreshUrl: refresh.href };
}

async function linkFor(deps: PayoutOnboardingDeps, providerId: string, accountId: string): Promise<DirectOnboardingResult> {
  const { returnUrl, refreshUrl } = returnUrls(deps, providerId);
  return { kind: "link", url: await createAccountOnboardingLink({ accountId, returnUrl, refreshUrl, ...stripeOptions(deps) }) };
}

/** As startPayoutOnboarding, in the same order, for the host's own account (purpose DIRECT). */
export async function startDirectOnboarding(actor: HostActor, deps: PayoutOnboardingDeps): Promise<DirectOnboardingResult> {
  try {
    const id = (deps.newId ?? randomUUID)();
    const reserved = await deps.accounts.reserve(actor, {
      id, purpose: "DIRECT",
      creationParams: directAccountCreationParams({ providerId: actor.providerId, creationId: id }) as unknown as Record<string, unknown>,
    });
    let row: ConnectAccountRecord = reserved.account;
    if (row.stripeAccountRef === null) {
      let accountId: string | null;
      if (deps.now().getTime() - Date.parse(row.createdAtUtc) <= PAYOUT_ACCOUNT_IDEMPOTENCY_WINDOW_MS) {
        accountId = (await createDirectAccount({ creationId: row.id, creationParams: row.creationParams as unknown as DirectAccountCreationParams, ...stripeOptions(deps) })).accountId;
      } else {
        accountId = await findPayoutAccountByCreationId({ creationId: row.id, providerId: row.providerId, rowCreatedAtUtc: row.createdAtUtc, purpose: "direct", ...stripeOptions(deps) });
        if (accountId === null) return { kind: "failed", outcome: "directReview" };
      }
      row = await deps.accounts.recordAccountRef(actor, row.id, accountId);
    }
    return await linkFor(deps, actor.providerId, row.stripeAccountRef!);
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { kind: "failed", outcome: "directForbidden" };
    if (error instanceof StoreConflictError) return { kind: "failed", outcome: error.message === "SELLER_EXISTS" ? "directSeller" : "directUnavailable" };
    console.error(`[host-direct-account] onboarding not started: ${error instanceof Error ? error.name : "unknown error"}`);
    return { kind: "failed", outcome: "directUnavailable" };
  }
}

/** Stripe's refresh_url: a new Link for the account that already exists. The caller has checked the OWNER of `providerId`. */
export async function refreshDirectOnboardingLink(providerId: string, deps: PayoutOnboardingDeps): Promise<DirectOnboardingResult> {
  try {
    const current = await deps.accounts.currentDirect(providerId);
    if (!current?.account.stripeAccountRef) return { kind: "failed", outcome: "directNotStarted" };
    return await linkFor(deps, providerId, current.account.stripeAccountRef);
  } catch (error) {
    console.error(`[host-direct-account] onboarding link not renewed: ${error instanceof Error ? error.name : "unknown error"}`);
    return { kind: "failed", outcome: "directUnavailable" };
  }
}

/** Reads the account from Stripe and keeps what it says (no email: Stripe tells the host itself). Null when Stripe does not show the account to this platform. */
export async function syncDirectAccount(account: ConnectAccountRecord, ref: string, deps: PayoutOnboardingDeps): Promise<ConnectAccountState | null> {
  const readAtUtc = deps.now().toISOString();
  const status = await retrieveDirectAccountStatus({ accountId: ref, providerId: account.providerId, ...stripeOptions(deps) });
  if (status.kind === "unreachable") return null;
  await deps.accounts.saveSnapshot(account.id, {
    state: status.state, payoutReady: status.payoutReady, detailsSubmitted: status.detailsSubmitted, payoutsEnabled: status.payoutsEnabled,
    transfersActive: status.transfersActive, chargesEnabled: status.chargesEnabled, requirementsHash: status.requirementsHash, readAtUtc,
  }, { notify: false });
  return status.state;
}

export type DirectScreenState = "NOT_STARTED" | ConnectAccountState | "unknown";

/** The screen's state of the host's own account: Stripe is read on every load; when it cannot be, the last kept state; "unknown" when there is none. */
export async function loadDirectScreenState(providerId: string, deps: PayoutOnboardingDeps): Promise<{ readonly state: DirectScreenState; readonly accountRef: string | null }> {
  const current = await deps.accounts.currentDirect(providerId);
  const ref = current?.account.stripeAccountRef ?? null;
  if (!current || ref === null) return { state: "NOT_STARTED", accountRef: null };
  try {
    return { state: (await syncDirectAccount(current.account, ref, deps)) ?? "unknown", accountRef: ref };
  } catch {
    return { state: current.snapshot?.state ?? "unknown", accountRef: ref };
  }
}

export type DirectSellerResult =
  | { readonly kind: "registered" }
  | { readonly kind: "failed"; readonly outcome: DirectAccountFailure };

/**
 * The OWNER's consent after READY: Stripe is read again just before (the store needs a READY read of the last 5 minutes), then the
 * seller profile and the payout-account consent are written in one transaction. `accountLast4` only confirms it is the account shown.
 */
export async function registerDirectSeller(
  actor: HostActor,
  deps: DirectAccountDeps,
  input: { readonly accountLast4: string; readonly consentVersion: string },
): Promise<DirectSellerResult> {
  try {
    if (!deps.sellers) return { kind: "failed", outcome: "directUnavailable" };
    const current = await deps.accounts.currentDirect(actor.providerId);
    const ref = current?.account.stripeAccountRef ?? null;
    if (!current || ref === null) return { kind: "failed", outcome: "directNotStarted" };
    if (ref.slice(-4) !== input.accountLast4) return { kind: "failed", outcome: "directChanged" };
    if (await syncDirectAccount(current.account, ref, deps) !== "READY") return { kind: "failed", outcome: "directNotReady" };
    await deps.sellers.register(actor, { stripeConnectAccountRef: ref, consentVersion: input.consentVersion, nowUtc: deps.now().toISOString() });
    return { kind: "registered" };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { kind: "failed", outcome: "directForbidden" };
    if (error instanceof StoreConflictError) {
      if (error.message === "SELLER_EXISTS") return { kind: "failed", outcome: "directSeller" };
      if (error.message === "SELLER_DISCLOSURE_REQUIRED") return { kind: "failed", outcome: "directDisclosure" };
      if (error.message === "DIRECT_ACCOUNT_NOT_READY") return { kind: "failed", outcome: "directNotReady" };
      if (error.message === "PUBLIC_PROFILE_MISSING") return { kind: "failed", outcome: "directProfile" };
      return { kind: "failed", outcome: "directChanged" };
    }
    console.error(`[host-direct-account] seller not registered: ${error instanceof Error ? error.name : "unknown error"}`);
    return { kind: "failed", outcome: "directUnavailable" };
  }
}
