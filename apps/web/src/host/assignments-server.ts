import "server-only";
import {
  StoreAccessDeniedError, StoreConflictError, StoreValidationError,
  type AssignmentHistoryItem, type AssignmentOutcome, type HostActor, type HostAssignmentList, type OccurrenceAssignmentRepository,
} from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { occurrenceAssignmentRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock, loadHostProviders, readHostSession } from "@/lib/host/server";
import { accessTokenUsable } from "@/lib/host/session";
import { ASSIGNMENT_ACTION_FAILED_TEXT, ASSIGNMENT_CLOSED_TEXT, ASSIGNMENT_LOAD_FAILED_TEXT, ASSIGNMENT_TAKEN_TEXT } from "./assignments";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import type { HostActionResult } from "./payout";
import { bookingReaderActor } from "./site-bookings-server";

/*
 * The people who can serve an occurrence: the provider's OWNER and COHOST here (a product operator is recorded by NIHO's
 * office in v0). The store checks the membership again on every call.
 */

export type HostAssignmentsLoad = { status: "closed" } | { status: "error" } | ({ status: "live" } & HostAssignmentList);

export const assignmentsEnabled = () => !isHostMock() && config.occurrenceAssignmentEnabled && config.managedSalesEnabled;

const canServe = (provider: Pick<HostProvider, "memberRole">) => provider.memberRole === "OWNER" || provider.memberRole === "COHOST";

export async function loadAssignments(provider: Pick<HostProvider, "id" | "nihoUserId" | "memberRole">): Promise<HostAssignmentsLoad> {
  if (!assignmentsEnabled() || !canServe(provider)) return { status: "closed" };
  const repository = occurrenceAssignmentRepository();
  if (!repository) return { status: "closed" };
  try {
    return { status: "live", ...await repository.list(bookingReaderActor(provider)) };
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "closed" } : { status: "error" };
  }
}

type Opened = { ok: true; repository: OccurrenceAssignmentRepository; actor: HostActor } | { ok: false; message: string };

async function open(providerId: string): Promise<Opened> {
  if (!assignmentsEnabled()) return { ok: false, message: ASSIGNMENT_CLOSED_TEXT };
  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const repository = occurrenceAssignmentRepository();
  if (!repository) return { ok: false, message: ASSIGNMENT_ACTION_FAILED_TEXT };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? ASSIGNMENT_ACTION_FAILED_TEXT : HOST_SESSION_ENDED_TEXT };
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (!provider || !canServe(provider)) return { ok: false, message: ASSIGNMENT_CLOSED_TEXT };
  return { ok: true, repository, actor: bookingReaderActor(provider) };
}

function failure(error: unknown): { ok: false; message: string } {
  if (error instanceof StoreAccessDeniedError) return { ok: false, message: ASSIGNMENT_CLOSED_TEXT };
  if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
  if (error instanceof StoreConflictError) return { ok: false, message: ASSIGNMENT_CLOSED_TEXT };
  console.error("Occurrence assignment failed", { error: error instanceof Error ? error.name : typeof error });
  return { ok: false, message: ASSIGNMENT_ACTION_FAILED_TEXT };
}

const DONE: Record<AssignmentOutcome, string> = {
  ASSIGNED: "担当になりました。",
  ALREADY_YOURS: "すでに担当になっています。",
  TAKEN: ASSIGNMENT_TAKEN_TEXT,
  DECLINED: "行けないと記録しました。",
  ALREADY_DECLINED: "行けないと記録済みです。",
  RELEASED: "担当を外れました。募集中に戻りました。",
  ALREADY_OPEN: "すでに募集中です。",
  FEE_SET: "記録しました。",
};

/** The answer a screen needs: ok, the outcome, and the list as it is now (a late 対応する learns 担当済み from it). */
export type HostAssignmentAnswer =
  | { ok: true; message: string; outcome: AssignmentOutcome; list: HostAssignmentList }
  | { ok: false; message: string; outcome?: AssignmentOutcome; list?: HostAssignmentList };

async function run(providerId: string, work: (opened: Extract<Opened, { ok: true }>) => Promise<{ outcome: AssignmentOutcome }>): Promise<HostAssignmentAnswer> {
  const opened = await open(providerId);
  if (!opened.ok) return opened;
  try {
    const result = await work(opened);
    const list = await opened.repository.list(opened.actor);
    // Pressing 対応する when someone else already did is an answer, not an error: the list shows 担当済み.
    return { ok: result.outcome !== "TAKEN", message: DONE[result.outcome], outcome: result.outcome, list };
  } catch (error) {
    return failure(error);
  }
}

export const claimOccurrence = (providerId: string, occurrenceId: string, commandId: string) =>
  run(providerId, ({ repository, actor }) => repository.claim(actor, { occurrenceId, commandId }));

export const declineOccurrence = (providerId: string, occurrenceId: string, commandId: string, reason: string) =>
  run(providerId, ({ repository, actor }) => repository.decline(actor, { occurrenceId, commandId, reason }));

export const releaseOccurrence = (providerId: string, occurrenceId: string, commandId: string, reason: string) =>
  run(providerId, ({ repository, actor }) => repository.release(actor, { occurrenceId, commandId, reason }));

export async function readAssignmentList(providerId: string): Promise<HostActionResult<{ list: HostAssignmentList }>> {
  const opened = await open(providerId);
  if (!opened.ok) return opened;
  try { return { ok: true, message: "", list: await opened.repository.list(opened.actor) }; }
  catch (error) { return error instanceof StoreAccessDeniedError ? { ok: false, message: ASSIGNMENT_CLOSED_TEXT } : { ok: false, message: ASSIGNMENT_LOAD_FAILED_TEXT }; }
}

export async function readAssignmentHistory(providerId: string, occurrenceId: string): Promise<HostActionResult<{ history: readonly AssignmentHistoryItem[] }>> {
  const opened = await open(providerId);
  if (!opened.ok) return opened;
  try { return { ok: true, message: "", history: await opened.repository.history(opened.actor, { occurrenceId }) }; }
  catch (error) { return error instanceof StoreAccessDeniedError ? { ok: false, message: ASSIGNMENT_CLOSED_TEXT } : { ok: false, message: ASSIGNMENT_LOAD_FAILED_TEXT }; }
}
