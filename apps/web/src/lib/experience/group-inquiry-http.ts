import "server-only";
import { publicEmpty, publicJson, readPublicJsonObject, retryAfterHeader } from "@/lib/experience/public-http";

/*
 * The public route of 団体・個別の相談 (#532, docs/group-inquiry.md). The body carries a name, an address and what the
 * person wrote, so none of it is logged, cached or put in a URL (the shared headers and same-site check: public-http.ts).
 * The answer is a closed body: the form shows its own words for each code and never the server's.
 */

/** Every body this route takes fits in this many bytes (a message of 4000 characters and the answers fit twice over). */
export const GROUP_INQUIRY_BODY_LIMIT = 32 * 1024;

export type GroupInquiryErrorCode = "VALIDATION_ERROR" | "INPUT_INVALID" | "RATE_LIMITED" | "SEND_FAILED";

const STATUS: Record<GroupInquiryErrorCode, number> = { VALIDATION_ERROR: 400, INPUT_INVALID: 422, RATE_LIMITED: 429, SEND_FAILED: 503 };

export const groupInquiryEmpty = publicEmpty;
export const groupInquiryJson = publicJson;

/** The closed `{ error }` body. `status` overrides the code's own (413 for a body that is too large). */
export function groupInquiryError(code: GroupInquiryErrorCode, { field = null, retryAfterSeconds, status }: { field?: string | null; retryAfterSeconds?: number; status?: number } = {}): Response {
  const error = { code, retryable: code === "RATE_LIMITED" || code === "SEND_FAILED", field };
  return publicJson(status ?? STATUS[code], { error }, retryAfterHeader(retryAfterSeconds));
}

export async function readGroupInquiryBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readPublicJsonObject(request, GROUP_INQUIRY_BODY_LIMIT);
  if (!body.ok) return { ok: false, response: groupInquiryError("VALIDATION_ERROR", body.tooLarge ? { status: 413 } : {}) };
  return body;
}
