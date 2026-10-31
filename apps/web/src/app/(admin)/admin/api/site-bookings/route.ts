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
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ["CANCEL", "APPROVE_REQUEST", "DECLINE_REQUEST", "RESOLVE_PAYMENT_REVIEW", "RETRY_REFUND", "CLOSE_REFUND"] as const;
type Action = (typeof ACTIONS)[number];

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

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function refundChoice(value: unknown): { kind: "FULL" } | { kind: "PARTIAL"; amount: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const choice = value as Record<string, unknown>;
  if (choice.kind === "FULL") return { kind: "FULL" };
  if (choice.kind === "PARTIAL" && Number.isSafeInteger(choice.amount)) return { kind: "PARTIAL", amount: choice.amount as number };
  return null;
}

function run(cancellations: BookingCancellations, actor: SupportActor, action: Action, body: Record<string, unknown>, commandId: string): Promise<CancellationResult> | null {
  const bookingId = str(body.publicBookingId) ?? "";
  const refundId = str(body.refundId) ?? "";
  const refund = refundChoice(body.refund);
  switch (action) {
    case "CANCEL":
      if (!refund) return null;
      return cancellations.cancelAsSupport(actor, bookingId, { commandId, reason: str(body.reason) as never, note: str(body.note) ?? null, refund });
    case "APPROVE_REQUEST":
      if (!refund) return null;
      return cancellations.resolveCancellationRequest(actor, bookingId, { commandId, decision: "APPROVE", refund, note: str(body.note) ?? null });
    case "DECLINE_REQUEST":
      return cancellations.resolveCancellationRequest(actor, bookingId, { commandId, decision: "DECLINE", message: str(body.message) ?? "" });
    case "RESOLVE_PAYMENT_REVIEW":
      return cancellations.resolvePaymentReview(actor, bookingId, { commandId });
    case "RETRY_REFUND":
      return cancellations.retryRefund(actor, refundId, { commandId });
    case "CLOSE_REFUND":
      return cancellations.closeFailedRefund(actor, refundId, { commandId, note: str(body.note) ?? "" });
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
  const action = ACTIONS.find((item) => item === body.action);
  const commandId = str(body.commandId);
  if (!action || !commandId || !UUID.test(commandId)) return adminJson({ error: "invalid_input" }, 400);
  const cancellations = bookingCancellations();
  if (!cancellations) return adminJson({ error: "unavailable" }, 503);
  let result: CancellationResult;
  try {
    const pending = run(cancellations, session.actor, action, body, commandId);
    if (!pending) return adminJson({ error: "invalid_input" }, 400);
    result = await pending;
  } catch (error) {
    return failure(error);
  }
  const refunds = await sendRefunds(result.refunds, { cancellations, submit: stripeRefundSubmitter() });
  return adminJson({ outcome: result.outcome, repeated: result.repeated, bookingIds: result.bookingIds, refunds });
}
