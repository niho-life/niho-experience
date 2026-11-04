import "server-only";
import { readBookingSettlement, submitSettlementTransfer } from "@niho-experience/experience-payments";
import type { ExperienceSupportRepository } from "@niho-experience/experience-store";

export interface SettlementReconciliationDeps {
  readonly repository: Pick<ExperienceSupportRepository, "initializeMissingSettlements" | "claimDueSettlements" | "getSettlementSource" | "recordStripeEvidence" | "prepareCompensation" | "markCompensation">;
  readonly platformStripeKey: string;
  readonly now?: () => Date;
}

export interface SettlementReconciliationCounts {
  initialized: number;
  claimed: number;
  reconciled: number;
  transferred: number;
  attention: number;
  failed: number;
}

/** One claimed settlement at a time; a failed Stripe/DB call leaves a bounded retry claim in the repository. */
export async function runSettlementReconciliation(
  deps: SettlementReconciliationDeps,
  limit = 20,
): Promise<SettlementReconciliationCounts> {
  const initialization = await deps.repository.initializeMissingSettlements(limit);
  const ids = await deps.repository.claimDueSettlements(limit);
  const counts = { initialized: initialization.initialized, claimed: ids.length, reconciled: 0, transferred: 0, attention: initialization.failed, failed: initialization.failed };
  for (const publicBookingId of ids) {
    try {
      const source = await deps.repository.getSettlementSource(publicBookingId);
      const evidence = await readBookingSettlement({
        publicBookingId: source.publicBookingId,
        connectedAccountId: source.connectedAccountId,
        paymentIntentId: source.paymentIntentId,
        expectedGrossAmount: source.grossAmount,
        expectedCurrency: source.currency,
        platformStripeKey: deps.platformStripeKey,
      });
      const summary = await deps.repository.recordStripeEvidence(publicBookingId, evidence);
      counts.reconciled += 1;
      if (summary.issueCode) {
        counts.attention += 1;
        continue;
      }
      const command = await deps.repository.prepareCompensation(publicBookingId);
      if (!command) continue;
      if (command.status === "TRANSFERRED") continue;
      await deps.repository.markCompensation(command.commandId, { status: "SUBMITTING" });
      try {
        const answer = await submitSettlementTransfer({ command, platformStripeKey: deps.platformStripeKey, now: deps.now?.() });
        if (answer.kind === "transferred" || answer.kind === "already_transferred") {
          await deps.repository.markCompensation(command.commandId, { status: "TRANSFERRED", stripeTransferRef: answer.stripeTransferRef });
          counts.transferred += 1;
        } else if (answer.kind === "retryable_failed") {
          await deps.repository.markCompensation(command.commandId, { status: "RETRYABLE_FAILED", issueCode: answer.issueCode });
          counts.attention += 1;
        } else if (answer.kind === "unknown") {
          await deps.repository.markCompensation(command.commandId, { status: "RESULT_UNKNOWN", issueCode: "settlement_transfer_result_unknown" });
          counts.attention += 1;
        } else {
          await deps.repository.markCompensation(command.commandId, { status: "REVIEW_REQUIRED", issueCode: answer.issueCode });
          counts.attention += 1;
        }
      } catch {
        // Stripe may have created the transfer before the network or database failed. Next run first searches its
        // transfer_group and command metadata; it never submits an unknown result again.
        await deps.repository.markCompensation(command.commandId, { status: "RESULT_UNKNOWN", issueCode: "settlement_transfer_result_unknown" });
        counts.attention += 1;
      }
    } catch {
      counts.failed += 1;
    }
  }
  if (counts.failed > 0) throw Object.assign(new Error("Settlement reconciliation failed."), { counts });
  return counts;
}
