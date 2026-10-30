import "server-only";
import { config } from "@/lib/config";
import { readBoundedJson } from "@/lib/host/bounded-json";

/*
 * What the public same-origin routes of the experience DB share: 予約前の質問 (#105, docs/guest-questions.md)
 * and 旅行者の予約 (#285, docs/guest-booking.md). Their bodies carry names, addresses, phone numbers and one-time
 * tokens, so no answer is cached, indexed or sent with a Referer, and nothing they receive is logged.
 */

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
} as const;

/** A status with no body (404, 403). */
export function publicEmpty(status: number): Response {
  return new Response(null, { status, headers: HEADERS });
}

export function publicJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...headers } });
}

/** Retry-After in whole seconds, at least 1. */
export function retryAfterHeader(seconds: number | null | undefined): Record<string, string> {
  return seconds ? { "retry-after": String(Math.max(1, Math.ceil(seconds))) } : {};
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

export type PublicJsonObject = { ok: true; value: Record<string, unknown> } | { ok: false; tooLarge: boolean };

/** The JSON object the page sent, at most `limit` bytes of application/json. */
export async function readPublicJsonObject(request: Request, limit: number): Promise<PublicJsonObject> {
  const body = await readBoundedJson(request, limit);
  if (!body.ok) return { ok: false, tooLarge: body.reason === "too_large" };
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, tooLarge: false };
  return { ok: true, value: value as Record<string, unknown> };
}
