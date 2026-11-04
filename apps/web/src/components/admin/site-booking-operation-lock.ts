export type ContactGuestCommand = {
  readonly action: "CONTACT_GUEST";
  readonly commandId: string;
  readonly publicBookingId: string;
  readonly message: string;
};

type FinancialPhase = "FORM" | "PREVIEW_IN_FLIGHT" | "EXECUTION_IN_FLIGHT" | "EXECUTION_UNKNOWN";

export type SiteBookingOperationLock =
  | { readonly kind: "CONTACT"; readonly ownerId: string; readonly commandId: string; readonly phase: "IN_FLIGHT" | "UNKNOWN" }
  | { readonly kind: "FINANCIAL"; readonly ownerId: string; readonly phase: FinancialPhase };

export type LockTransition = { readonly accepted: boolean; readonly lock: SiteBookingOperationLock | null };

export function contactCommand(
  existing: ContactGuestCommand | null,
  input: { readonly publicBookingId: string; readonly message: string },
  createCommandId: () => string,
): ContactGuestCommand {
  return existing ?? { action: "CONTACT_GUEST", commandId: createCommandId(), publicBookingId: input.publicBookingId, message: input.message };
}

/** Starts a first contact, or retries only the same owner's same unknown-result command. */
export function beginContactOperation(current: SiteBookingOperationLock | null, ownerId: string, commandId: string): LockTransition {
  if (current === null) return { accepted: true, lock: { kind: "CONTACT", ownerId, commandId, phase: "IN_FLIGHT" } };
  if (current.kind === "CONTACT" && current.ownerId === ownerId && current.commandId === commandId && current.phase === "UNKNOWN") {
    return { accepted: true, lock: { ...current, phase: "IN_FLIGHT" } };
  }
  return { accepted: false, lock: current };
}

export function markContactUnknown(current: SiteBookingOperationLock | null, ownerId: string, commandId: string): LockTransition {
  if (current?.kind === "CONTACT" && current.ownerId === ownerId && current.commandId === commandId) {
    return { accepted: true, lock: { ...current, phase: "UNKNOWN" } };
  }
  return { accepted: false, lock: current };
}

export function releaseContactOperation(current: SiteBookingOperationLock | null, ownerId: string, commandId: string): LockTransition {
  if (current?.kind === "CONTACT" && current.ownerId === ownerId && current.commandId === commandId) return { accepted: true, lock: null };
  return { accepted: false, lock: current };
}

/** A financial form owns the global gate from opening through its final result or explicit cancellation. */
export function claimFinancialOperation(current: SiteBookingOperationLock | null, ownerId: string): LockTransition {
  return current === null
    ? { accepted: true, lock: { kind: "FINANCIAL", ownerId, phase: "FORM" } }
    : { accepted: false, lock: current };
}

function changeFinancialPhase(
  current: SiteBookingOperationLock | null,
  ownerId: string,
  allowed: readonly FinancialPhase[],
  phase: FinancialPhase,
): LockTransition {
  if (current?.kind === "FINANCIAL" && current.ownerId === ownerId && allowed.includes(current.phase)) {
    return { accepted: true, lock: { ...current, phase } };
  }
  return { accepted: false, lock: current };
}

export const beginFinancialPreview = (current: SiteBookingOperationLock | null, ownerId: string): LockTransition =>
  changeFinancialPhase(current, ownerId, ["FORM"], "PREVIEW_IN_FLIGHT");

export const finishFinancialPreview = (current: SiteBookingOperationLock | null, ownerId: string): LockTransition =>
  changeFinancialPhase(current, ownerId, ["PREVIEW_IN_FLIGHT"], "FORM");

export const beginFinancialExecution = (current: SiteBookingOperationLock | null, ownerId: string): LockTransition =>
  changeFinancialPhase(current, ownerId, ["FORM", "EXECUTION_UNKNOWN"], "EXECUTION_IN_FLIGHT");

export const markFinancialUnknown = (current: SiteBookingOperationLock | null, ownerId: string): LockTransition =>
  changeFinancialPhase(current, ownerId, ["EXECUTION_IN_FLIGHT"], "EXECUTION_UNKNOWN");

export const resetFinancialForm = (current: SiteBookingOperationLock | null, ownerId: string): LockTransition =>
  changeFinancialPhase(current, ownerId, ["EXECUTION_IN_FLIGHT"], "FORM");

export function releaseFinancialOperation(current: SiteBookingOperationLock | null, ownerId: string): LockTransition {
  if (current?.kind === "FINANCIAL" && current.ownerId === ownerId) return { accepted: true, lock: null };
  return { accepted: false, lock: current };
}
