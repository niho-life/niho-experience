import "server-only";
import type { GuestReviewLanguage } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { publicEmpty, publicJson, readPublicJsonObject } from "@/lib/experience/public-http";

export const REVIEW_BODY_LIMIT = 16 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9._:-]{8,120}$/;

/** Writing is enabled only when an explicit attendance mark can be checked. */
export function reviewWritingEnabled(): boolean {
  return config.apiMode === "http" && config.guestReviewsEnabled && config.hostAttendanceEnabled;
}

export function reviewToken(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

export type ReviewBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

export async function readReviewBody(request: Request): Promise<ReviewBody> {
  const result = await readPublicJsonObject(request, REVIEW_BODY_LIMIT);
  if (!result.ok) return { ok: false, response: reviewError("INPUT_INVALID", result.tooLarge ? 413 : 400) };
  return result;
}

export function reviewError(code: "INPUT_INVALID" | "LINK_USED" | "UNAVAILABLE", status = code === "INPUT_INVALID" ? 422 : code === "LINK_USED" ? 409 : 503): Response {
  return publicJson(status, { error: { code, message: code === "INPUT_INVALID" ? "Please check your review." : code === "LINK_USED" ? "This link has already been used." : "Please try again." } });
}

export { publicEmpty, publicJson };

/** The route never passes arbitrary request keys or fields through to the store. */
export function reviewSubmission(value: Record<string, unknown>): {
  rating: number; body: string; displayName: string; tags: string[]; originLabel: string | null; noteToHost: string | null; clientRequestKey: string; language: GuestReviewLanguage;
} | null {
  if (Object.keys(value).some((key) => !["token", "rating", "body", "displayName", "tags", "originLabel", "noteToHost", "clientRequestKey", "language"].includes(key))) return null;
  if (!Number.isInteger(value.rating) || (value.rating as number) < 1 || (value.rating as number) > 5
    || typeof value.body !== "string" || value.body.trim().length < 1 || value.body.trim().length > 2000
    || typeof value.displayName !== "string" || value.displayName.trim().length < 1 || value.displayName.trim().length > 60
    || typeof value.clientRequestKey !== "string" || !KEY.test(value.clientRequestKey)) return null;
  const tags = value.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 5 || tags.some((tag) => typeof tag !== "string")) return null;
  const language = value.language ?? "EN";
  if (language !== "EN" && language !== "JA") return null;
  const originLabel = value.originLabel ?? null;
  const noteToHost = value.noteToHost ?? null;
  if ((originLabel !== null && (typeof originLabel !== "string" || originLabel.length > 60))
    || (noteToHost !== null && (typeof noteToHost !== "string" || noteToHost.length > 500))) return null;
  return {
    rating: value.rating as number, body: value.body, displayName: value.displayName,
    tags: tags as string[], originLabel: originLabel as string | null, noteToHost: noteToHost as string | null,
    clientRequestKey: value.clientRequestKey, language,
  };
}
