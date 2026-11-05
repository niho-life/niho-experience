import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type BookingCancellations,
  type CancellationResult,
  type SupportActor,
} from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { sendRefunds, stripeRefundSubmitter } from "@/lib/experience/booking-refunds";
import { bookingCancellations } from "@/lib/experience/store-server";
import { guestBookingMessages } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { parseContactCommand, parseFinancialCommand, type FinancialCommand } from "./request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 8 * 1024;

/*
 * 取消と返金 for NIHO support (#285 slice 7, docs/guest-booking.md「取消と返金（第7段）」): the bookings made on this
 * site that need support (open "Ask to cancel" requests, payments under review, refunds Stripe has not answered or
 * that failed) and support's actions on them. The Admin console's own sign-in: NIHO verifies the dedicated client and
 * the current ADMIN role on every call (loadAdminHttpSession), POSTs come from the Admin origin only, and the store
 * records who acted. Every action carries the page's UUID: sent again after a lost answer it does nothing twice.
 */

const enabled = () => config.guestBookingEnabled && isAdminHttp();

function failure(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreAccessDeniedError) return adminJson({ error: "forbidden" }, 403);
  console.error("Experience support cancellation failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

async function signedIn(): Promise<{ ok: true; actor: SupportActor } | { ok: false; response: Response }> {
  const loaded = await loadAdminHttpSession();
  if (loaded.status === "ok") return { ok: true, actor: { nihoUserId: loaded.verified.actor.id } };
  return { ok: false, response: adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401) };
}

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const session = await signedIn();
  if (!session.ok) return session.response;
  const cancellations = bookingCancellations();
  if (!cancellations) return adminJson({ error: "unavailable" }, 503);
  try {
    return adminJson(await cancellations.supportQueue({ limit: 100 }));
  } catch (error) {
    return failure(error);
  }
}

function run(cancellations: BookingCancellations, actor: SupportActor, command: FinancialCommand): Promise<CancellationResult> {
  switch (command.action) {
    case "CANCEL":
      return cancellations.cancelAsSupport(actor, command.publicBookingId!, { commandId: command.commandId, expectedSnapshot: command.expectedSnapshot, reason: command.reason as never, note: command.note ?? null, refund: command.refund! });
    case "APPROVE_REQUEST":
      return cancellations.resolveCancellationRequest(actor, command.publicBookingId!, { commandId: command.commandId, expectedSnapshot: command.expectedSnapshot, decision: "APPROVE", refund: command.refund!, note: command.note ?? null });
    case "DECLINE_REQUEST":
      return cancellations.resolveCancellationRequest(actor, command.publicBookingId!, { commandId: command.commandId, expectedSnapshot: command.expectedSnapshot, decision: "DECLINE", message: command.message! });
    case "RESOLVE_PAYMENT_REVIEW":
      return cancellations.resolvePaymentReview(actor, command.publicBookingId!, { commandId: command.commandId, expectedSnapshot: command.expectedSnapshot });
    case "RETRY_REFUND":
      return cancellations.retryRefund(actor, command.refundId!, { commandId: command.commandId, expectedSnapshot: command.expectedSnapshot });
    case "CLOSE_REFUND":
      return cancellations.closeFailedRefund(actor, command.refundId!, { commandId: command.commandId, expectedSnapshot: command.expectedSnapshot, note: command.note ?? "" });
  }
}

/**
 * `{ action, commandId, publicBookingId | refundId, ... }`. The store decides what each action may do; the refunds it
 * asks for are then sent to Stripe on the seller's account. 200 `{ outcome, repeated, bookingIds, refunds }`, where
 * each refund says where it is now (REQUESTED when Stripe could not take it yet: it shows in the list after a while).
 */
export async function POST(request: Request): Promise<Response> {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return adminJson({ error: "invalid_input" }, 400);
  }
  const session = await signedIn();
  if (!session.ok) return session.response;
  let body: Record<string, unknown>;
  try {
    const value = await readBoundedJson(request, BODY_LIMIT);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("shape");
    body = value as Record<string, unknown>;
  } catch {
    return adminJson({ error: "invalid_input" }, 400);
  }
  if (body.action === "CONTACT_GUEST") {
    const command = parseContactCommand(body);
    if (!command) return adminJson({ error: "invalid_input" }, 400);
    const messages = guestBookingMessages();
    if (!messages) return adminJson({ error: "unavailable" }, 503);
    try {
      const result = await messages.sendSupportMessage(session.actor, command.publicBookingId, { commandId: command.commandId, message: command.message });
      return adminJson({ outcome: "CONTACT_SENT", repeated: result.repeated });
    } catch (error) {
      return failure(error);
    }
  }
  const command = parseFinancialCommand(body);
  if (!command) return adminJson({ error: "invalid_input" }, 400);
  const cancellations = bookingCancellations();
  if (!cancellations) return adminJson({ error: "unavailable" }, 503);
  let result: CancellationResult;
  try {
    result = await run(cancellations, session.actor, command);
  } catch (error) {
    return failure(error);
  }
  const refunds = await sendRefunds(result.refunds, { cancellations, submit: stripeRefundSubmitter() });
  return adminJson({ outcome: result.outcome, repeated: result.repeated, bookingIds: result.bookingIds, refunds });
}
