import {
  createAccountOnboardingLink,
  createPayoutAccount,
  findPayoutAccountByCreationId,
  PAYOUT_ACCOUNT_IDEMPOTENCY_WINDOW_MS,
  payoutAccountCreationParams,
  retrievePayoutAccountStatus,
  type PayoutAccountCreationParams,
  type PayoutAccountStripeClient,
} from "@niho-experience/experience-payments";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  type ConnectAccountRecord,
  type ConnectAccountState,
  type ExperienceConnectAccounts,
  type HostActor,
} from "@niho-experience/experience-store";
import { randomUUID } from "node:crypto";

/*
 * ホストが自分で受取口座（Stripe Express）を登録する (Epic #700 stage 3a, #710, docs/host-payouts.md): the flow, with its
 * collaborators passed in (the routes and the screen wire the real store and Stripe; the tests wire fakes). Nothing here
 * logs, stores or returns an Account Link URL except to the caller that redirects to it at once.
 */

export type PayoutOnboardingStore = Pick<ExperienceConnectAccounts, "reserve" | "recordAccountRef" | "currentPayout" | "findByAccountRef" | "saveSnapshot" | "sellerExists">;

export interface PayoutOnboardingDeps {
  readonly accounts: PayoutOnboardingStore;
  readonly platformStripeKey: string;
  /** Tests only. */
  readonly stripe?: PayoutAccountStripeClient;
  /** `SITE_URL`'s origin: where Stripe sends the host back. */
  readonly siteOrigin: string;
  readonly now: () => Date;
  readonly newId?: () => string;
}

/** What went wrong, in the words 設定 › 受取口座 says near the button (`?payout=`). */
export type PayoutOnboardingFailure = "connectForbidden" | "connectSeller" | "connectUnavailable" | "connectReview" | "connectNotStarted";

export type PayoutOnboardingResult =
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "failed"; readonly outcome: PayoutOnboardingFailure };

const stripeOptions = (deps: PayoutOnboardingDeps) => (deps.stripe ? { stripe: deps.stripe } : { platformStripeKey: deps.platformStripeKey });

/** Where Stripe sends the host: back to 受取口座 (which reads the account again), and to the route that makes a new link. */
function returnUrls(deps: PayoutOnboardingDeps, providerId: string): { returnUrl: string; refreshUrl: string } {
  const settings = new URL("/host/settings", deps.siteOrigin);
  settings.searchParams.set("providerId", providerId);
  settings.searchParams.set("connect", "return");
  const refresh = new URL("/host/api/payout-account/onboarding/refresh", deps.siteOrigin);
  refresh.searchParams.set("providerId", providerId);
  return { returnUrl: settings.href, refreshUrl: refresh.href };
}

async function linkFor(deps: PayoutOnboardingDeps, providerId: string, accountId: string): Promise<PayoutOnboardingResult> {
  const { returnUrl, refreshUrl } = returnUrls(deps, providerId);
  const url = await createAccountOnboardingLink({ accountId, returnUrl, refreshUrl, ...stripeOptions(deps) });
  return { kind: "link", url };
}

/**
 * Makes sure the account exists, then gives the Account Link. In this order: (1) the row is reserved before Stripe is asked, so
 * two requests share one row and one idempotency key; (2) accounts.create is called with the row's id and its stored parameters,
 * for 23 hours after the row was made (Stripe keeps a key for 24); (3) the account ID is written once; (4) later than 23 hours
 * the account an unfinished creation may have made is looked for by its metadata, and never created again.
 */
export async function startPayoutOnboarding(actor: HostActor, deps: PayoutOnboardingDeps): Promise<PayoutOnboardingResult> {
  try {
    const id = (deps.newId ?? randomUUID)();
    const reserved = await deps.accounts.reserve(actor, { id, creationParams: payoutAccountCreationParams({ providerId: actor.providerId, creationId: id }) as unknown as Record<string, unknown> });
    let row: ConnectAccountRecord = reserved.account;
    if (row.stripeAccountRef === null) {
      let accountId: string | null;
      if (deps.now().getTime() - Date.parse(row.createdAtUtc) <= PAYOUT_ACCOUNT_IDEMPOTENCY_WINDOW_MS) {
        accountId = (await createPayoutAccount({ creationId: row.id, creationParams: row.creationParams as unknown as PayoutAccountCreationParams, ...stripeOptions(deps) })).accountId;
      } else {
        accountId = await findPayoutAccountByCreationId({ creationId: row.id, providerId: row.providerId, rowCreatedAtUtc: row.createdAtUtc, ...stripeOptions(deps) });
        // Nothing found: the office looks at it. Another account is never made for this row.
        if (accountId === null) return { kind: "failed", outcome: "connectReview" };
      }
      row = await deps.accounts.recordAccountRef(actor, row.id, accountId);
    }
    return await linkFor(deps, actor.providerId, row.stripeAccountRef!);
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { kind: "failed", outcome: "connectForbidden" };
    if (error instanceof StoreConflictError) return { kind: "failed", outcome: error.message === "SELLER_EXISTS" ? "connectSeller" : "connectUnavailable" };
    console.error(`[host-payout-account] onboarding not started: ${error instanceof Error ? error.name : "unknown error"}`);
    return { kind: "failed", outcome: "connectUnavailable" };
  }
}

/** Stripe's refresh_url: a new Link for the account that already exists. The caller has checked the OWNER of `providerId`. */
export async function refreshPayoutOnboardingLink(providerId: string, deps: PayoutOnboardingDeps): Promise<PayoutOnboardingResult> {
  try {
    const current = await deps.accounts.currentPayout(providerId);
    if (!current?.account.stripeAccountRef) return { kind: "failed", outcome: "connectNotStarted" };
    return await linkFor(deps, providerId, current.account.stripeAccountRef);
  } catch (error) {
    console.error(`[host-payout-account] onboarding link not renewed: ${error instanceof Error ? error.name : "unknown error"}`);
    return { kind: "failed", outcome: "connectUnavailable" };
  }
}

/** What 設定 › 受取口座 shows: no account yet, one of Stripe's states, or "unknown" (Stripe could not be read and nothing was kept). */
export type PayoutScreenState = "NOT_STARTED" | ConnectAccountState | "unknown";

/**
 * The screen's state for a provider: Stripe is read on every load and the answer kept. When Stripe cannot be read now, the last
 * kept state is shown instead (and "unknown" when there is none). An account Stripe does not show is "unknown", not the kept state. A provider with a Direct charge seller shows none of this.
 */
export async function loadPayoutScreenState(providerId: string, deps: PayoutOnboardingDeps): Promise<{ readonly state: PayoutScreenState } | "seller"> {
  const current = await deps.accounts.currentPayout(providerId);
  if (!current) return (await deps.accounts.sellerExists(providerId)) ? "seller" : { state: "NOT_STARTED" };
  const ref = current.account.stripeAccountRef;
  if (ref === null) return { state: "NOT_STARTED" };
  const kept = current.snapshot?.state ?? "unknown";
  try {
    const synced = await syncPayoutAccount(current.account, ref, deps, { notify: false });
    // Stripe no longer shows the account (gone, or not ours): never the last kept state, which is stale. Only an error falls back to it.
    return { state: synced ?? "unknown" };
  } catch {
    return { state: kept };
  }
}

/** Reads the account from Stripe and keeps what it says. Null when Stripe does not show the account to this platform. */
async function syncPayoutAccount(account: ConnectAccountRecord, ref: string, deps: PayoutOnboardingDeps, options: { readonly notify: boolean }): Promise<ConnectAccountState | null> {
  const readAtUtc = deps.now().toISOString();
  const status = await retrievePayoutAccountStatus({ accountId: ref, providerId: account.providerId, ...stripeOptions(deps) });
  if (status.kind === "unreachable") return null;
  await deps.accounts.saveSnapshot(account.id, {
    state: status.state, payoutReady: status.payoutReady, detailsSubmitted: status.detailsSubmitted, payoutsEnabled: status.payoutsEnabled,
    transfersActive: status.transfersActive, requirementsHash: status.requirementsHash, readAtUtc,
  }, options);
  return status.state;
}

/**
 * `account.updated` of a connected account (the Connect webhook): not one of ours (or a retired one) is ignored; ours is read
 * again from Stripe, never from the event, and the answer kept; more information needed mails the OWNER once per need.
 */
export async function applyAccountUpdated(connectedAccountId: string, deps: PayoutOnboardingDeps): Promise<"ignored" | "updated"> {
  const found = await deps.accounts.findByAccountRef(connectedAccountId);
  if (!found || found.account.retiredAtUtc !== null) return "ignored";
  await syncPayoutAccount(found.account, connectedAccountId, deps, { notify: true });
  return "updated";
}
