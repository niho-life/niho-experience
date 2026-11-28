import "server-only";
import {
  retrieveAgentPayoutCharge, retrievePayoutAccountStatus, reverseAgentPayoutTransfer, submitAgentPayoutTransfer,
} from "@niho-experience/experience-payments";
import type { AgentPayoutCommand, AgentPayoutRepository, ExperienceConnectAccounts } from "@niho-experience/experience-store";

/**
 * 代理受領の送金 (#725, Epic #700 stage 3b-2, docs/host-payouts.md「3b-2 送金」): one drain step. Rows are claimed with a lease and handled one at a
 * time; a failed call leaves its row to be claimed again, and one row's failure never stops the others. Stripe is read and written only outside
 * the store's transactions. An unknown transfer result is never sent again: the next run looks the transfer up by its group first.
 */
export interface AgentPayoutPayments {
  readonly retrieveAccountStatus: typeof retrievePayoutAccountStatus;
  readonly retrieveCharge: typeof retrieveAgentPayoutCharge;
  readonly submitTransfer: typeof submitAgentPayoutTransfer;
  readonly reverseTransfer: typeof reverseAgentPayoutTransfer;
}

export interface AgentPayoutsDeps {
  readonly repository: Pick<AgentPayoutRepository,
    "initializeMissing" | "claimDueLeased" | "extendLease" | "extendReversalLease" | "prepare" | "awaitAccount" | "markReview" | "begin" | "recordTransfer" | "claimDueReversals" | "recordReversal" | "escalateStaleOffsets">;
  readonly connectAccounts: Pick<ExperienceConnectAccounts, "currentPayout" | "saveSnapshot">;
  readonly platformStripeKey: string;
  readonly payments?: Partial<AgentPayoutPayments>;
  readonly now?: () => Date;
  /** EXPERIENCE_HOST_AGENT_PAYOUTS_PAUSED: the ledger is recalculated and unknown transfers are looked up, but no transfer or reversal is created. */
  readonly paused?: boolean;
  /** How long one run may keep calling Stripe (as the drain's other steps): rows not reached wait for the next run. */
  readonly budgetMs?: number;
}

export interface AgentPayoutCounts {
  initialized: number;
  claimed: number;
  transferred: number;
  awaitingAccount: number;
  attention: number;
  reversalsClaimed: number;
  reversed: number;
  /** Rows whose claim was lost (taken by another run or the office) before Stripe was called: left alone. */
  skipped: number;
  failed: number;
}

export async function runAgentPayouts(deps: AgentPayoutsDeps, limit = 20): Promise<AgentPayoutCounts> {
  const payments: AgentPayoutPayments = {
    retrieveAccountStatus: retrievePayoutAccountStatus, retrieveCharge: retrieveAgentPayoutCharge,
    submitTransfer: submitAgentPayoutTransfer, reverseTransfer: reverseAgentPayoutTransfer, ...deps.payments,
  };
  const now = () => deps.now?.() ?? new Date();
  const startedAt = now().getTime();
  const outOfTime = () => deps.budgetMs !== undefined && now().getTime() - startedAt >= deps.budgetMs;
  const paused = deps.paused === true;
  const initialization = await deps.repository.initializeMissing(limit);
  const counts: AgentPayoutCounts = {
    initialized: initialization.initialized, claimed: 0, transferred: 0, awaitingAccount: 0, attention: initialization.failed,
    reversalsClaimed: 0, reversed: 0, skipped: 0, failed: initialization.failed,
  };
  const claims = await deps.repository.claimDueLeased(limit);
  counts.claimed = claims.length;

  /** Looks the command's transfer up (or sends it) and writes the answer. An exception is an unknown result: it is looked up again, never resent blindly. */
  const settle = async (payoutId: string, command: AgentPayoutCommand, token: string): Promise<void> => {
    // The lease runs again from here: the Stripe calls below must finish well inside it, and the office is refused while it lives. Lost claim: no call.
    if (await deps.repository.extendLease(payoutId, token) === null) {
      counts.skipped += 1;
      return;
    }
    try {
      const answer = await payments.submitTransfer({ command, platformStripeKey: deps.platformStripeKey, now: now(), ...(paused ? { create: false } : {}) });
      // Paused and nothing found: the row stays as it is, to be looked up again.
      if (paused && answer.kind === "unknown") return;
      const status = await deps.repository.recordTransfer(payoutId, command.commandId, answer);
      if (status === "TRANSFERRED") counts.transferred += 1;
      else if (status === "AWAITING_ACCOUNT") counts.awaitingAccount += 1;
      else counts.attention += 1;
    } catch {
      await deps.repository.recordTransfer(payoutId, command.commandId, { kind: "unknown" });
      counts.attention += 1;
    }
  };

  for (const { id: payoutId, token: claimToken } of claims) {
    if (outOfTime()) break;
    try {
      let token = claimToken;
      const prepared = await deps.repository.prepare(payoutId, now());
      if (prepared.kind === "idle") continue;
      if (prepared.kind === "reconcile") {
        // The time budget is looked at before Stripe is called (not after a transfer was begun: that one is finished or looked up next run).
        if (outOfTime()) break;
        await settle(payoutId, prepared.command, token);
        continue;
      }
      // Paused: nothing is sent, so the account and the Charge are not read either.
      if (paused) continue;
      if (outOfTime()) break;
      const extended = await deps.repository.extendLease(payoutId, token);
      if (extended === null) {
        counts.skipped += 1;
        continue;
      }
      token = extended;
      const current = await deps.connectAccounts.currentPayout(prepared.providerId);
      const accountRef = current?.account.stripeAccountRef ?? null;
      if (!current || accountRef === null) {
        if ((await deps.repository.awaitAccount(payoutId, "payout_account_missing", now())).status === "REVIEW_REQUIRED") counts.attention += 1;
        else counts.awaitingAccount += 1;
        continue;
      }
      const read = await payments.retrieveAccountStatus({ accountId: accountRef, providerId: prepared.providerId, platformStripeKey: deps.platformStripeKey });
      if (read.kind === "unreachable") {
        if ((await deps.repository.awaitAccount(payoutId, "payout_account_unreachable", now())).status === "REVIEW_REQUIRED") counts.attention += 1;
        else counts.awaitingAccount += 1;
        continue;
      }
      await deps.connectAccounts.saveSnapshot(current.account.id, {
        state: read.state, payoutReady: read.payoutReady, detailsSubmitted: read.detailsSubmitted, payoutsEnabled: read.payoutsEnabled,
        transfersActive: read.transfersActive, requirementsHash: read.requirementsHash, readAtUtc: now().toISOString(),
      });
      if (!read.payoutReady) {
        if ((await deps.repository.awaitAccount(payoutId, "payout_account_not_ready", now())).status === "REVIEW_REQUIRED") counts.attention += 1;
        else counts.awaitingAccount += 1;
        continue;
      }
      if (outOfTime()) break;
      const charge = await payments.retrieveCharge({
        paymentIntentId: prepared.paymentRef, publicBookingId: prepared.publicBookingId, expectedAmount: prepared.capturedAmount, knownRefundedAmount: prepared.refundedAmount, knownDisputeCount: prepared.disputeCount, platformStripeKey: deps.platformStripeKey,
      });
      if (charge.kind === "mismatch") {
        await deps.repository.markReview(payoutId, charge.issueCode);
        counts.attention += 1;
        continue;
      }
      const command = await deps.repository.begin(payoutId, {
        destination: { connectAccountId: current.account.id, accountRef },
        charge: { ref: charge.chargeRef, amount: charge.amount, currency: charge.currency },
      }, now());
      if (command) await settle(payoutId, command, token);
    } catch {
      counts.failed += 1;
    }
  }

  // Taking back what was sent too much (a refund or a lost dispute after the payout), then what waited too long for later payouts.
  try {
    for (const reversal of paused || outOfTime() ? [] : await deps.repository.claimDueReversals(limit)) {
      if (outOfTime()) break;
      counts.reversalsClaimed += 1;
      try {
        // As for a transfer: the lease runs again right before Stripe is called, and a claim that was lost means no call.
        if (await deps.repository.extendReversalLease(reversal.adjustmentId, reversal.leaseToken) === null) {
          counts.skipped += 1;
          continue;
        }
        const answer = await payments.reverseTransfer({
          transferRef: reversal.stripeTransferRef, adjustmentId: reversal.adjustmentId, amount: reversal.amount, platformStripeKey: deps.platformStripeKey,
        });
        const status = await deps.repository.recordReversal(reversal.adjustmentId, answer);
        if (status === "REVERSED") counts.reversed += 1;
        else if (status === "REVIEW_REQUIRED") counts.attention += 1;
      } catch {
        try {
          await deps.repository.recordReversal(reversal.adjustmentId, { kind: "unknown" });
          counts.attention += 1;
        } catch {
          counts.failed += 1;
        }
      }
    }
    counts.attention += await deps.repository.escalateStaleOffsets(now());
  } catch {
    counts.failed += 1;
  }
  if (counts.failed > 0) throw Object.assign(new Error("Agent payouts failed."), { counts });
  return counts;
}
