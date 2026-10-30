import "server-only";
import { config } from "@/lib/config";
import { readBoundedJson } from "@/lib/host/bounded-json";

/*
 * The public routes of 予約前の質問 (#105, docs/guest-questions.md): "Ask the host" and the guest's reply
 * page post here. They carry names, addresses, what the guest wrote and one-time link tokens, so none of
 * it is logged, cached or put in a URL. The answers use the AskHost contract's closed error body
 * (packages/api-client/src/journey.ts).
 */

/** Every body these routes take fits in this many bytes. */
export const GUEST_QUESTION_BODY_LIMIT = 16 * 1024;

export type GuestQuestionErrorCode = "VALIDATION_ERROR" | "INPUT_INVALID" | "UNAVAILABLE" | "RATE_LIMITED" | "SEND_FAILED" | "LINK_USED";

const STATUS: Record<GuestQuestionErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INPUT_INVALID: 422,
  UNAVAILABLE: 409,
  LINK_USED: 409,
  RATE_LIMITED: 429,
  SEND_FAILED: 503,
};

const MESSAGES: Record<GuestQuestionErrorCode, string> = {
  VALIDATION_ERROR: "The request could not be read.",
  INPUT_INVALID: "Please check this field.",
  UNAVAILABLE: "Questions are not open for this experience.",
  LINK_USED: "This link was already used to reply.",
  RATE_LIMITED: "Too many questions. Please wait before sending another.",
  SEND_FAILED: "The message could not be saved. Please try again.",
};

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
} as const;

/** A status with no body (404, 403). */
export function guestQuestionEmpty(status: number): Response {
  return new Response(null, { status, headers: HEADERS });
}

export function guestQuestionJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...headers } });
}

/** The closed `{ error }` body. `status` overrides the code's own (413 for a body that is too large). */
export function guestQuestionError(code: GuestQuestionErrorCode, { field = null, retryAfterSeconds, status }: { field?: string | null; retryAfterSeconds?: number; status?: number } = {}): Response {
  const error = { code, message: MESSAGES[code], retryable: code === "RATE_LIMITED" || code === "SEND_FAILED", field };
  return guestQuestionJson(status ?? STATUS[code], { error }, retryAfterSeconds ? { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) } : {});
}

/**
 * Only this site's own pages post here: the browser's Origin must be the site's, and Sec-Fetch-Site,
 * where the browser sends it, must say same-origin. The pages send their POSTs with
 * `referrerPolicy: "same-origin"`, since the site's `no-referrer` would make the Origin `null`.
 */
export function fromThisSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  return request.headers.get("origin") === new URL(config.siteUrl).origin && (fetchSite === null || fetchSite === "same-origin");
}

export type GuestQuestionBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** The JSON object the page sent, at most GUEST_QUESTION_BODY_LIMIT bytes. */
export async function readGuestQuestionBody(request: Request): Promise<GuestQuestionBody> {
  const body = await readBoundedJson(request, GUEST_QUESTION_BODY_LIMIT);
  if (!body.ok) return { ok: false, response: guestQuestionError("VALIDATION_ERROR", body.reason === "too_large" ? { status: 413 } : {}) };
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, response: guestQuestionError("VALIDATION_ERROR") };
  return { ok: true, value: value as Record<string, unknown> };
}

/** The reply link's token as the page read it from the URL fragment; anything else is no link at all. */
export function replyToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** The page's idempotency key (a UUID from the browser). */
export function clientRequestKey(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(value) ? value : null;
}
