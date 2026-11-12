import { StoreRateLimitedError, StoreValidationError, checkGroupInquiry } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { groupInquiryRepository } from "@/lib/experience/store-server";
import { fromThisSite } from "@/lib/experience/public-http";
import { groupInquiryEmpty, groupInquiryError, groupInquiryJson, readGroupInquiryBody } from "@/lib/experience/group-inquiry-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUEST_KEY = /^[A-Za-z0-9._:-]{8,120}$/;

/**
 * 団体・個別の相談 (#532, docs/group-inquiry.md): the form's POST. It keeps an inquiry and queues two emails, and
 * nothing else: no stock, hold, payment or booking is touched. 201 `{ accepted: true, inquiryRef, replyByDate }` only
 * once the inquiry is stored (the page shows "received" on nothing else); 404 without a body while the flag is off, 403
 * from another origin, or the closed `{ error }` body. The same `clientRequestKey` is the same inquiry. Nothing in the
 * request is logged.
 */
export async function POST(request: Request): Promise<Response> {
  if (!config.groupInquiryEnabled) return groupInquiryEmpty(404);
  if (!fromThisSite(request)) return groupInquiryEmpty(403);
  const inquiries = groupInquiryRepository();
  if (!inquiries) return groupInquiryError("SEND_FAILED");
  const body = await readGroupInquiryBody(request);
  if (!body.ok) return body.response;

  const key = typeof body.value.clientRequestKey === "string" && REQUEST_KEY.test(body.value.clientRequestKey) ? body.value.clientRequestKey : null;
  if (!key) return groupInquiryError("INPUT_INVALID", { field: "clientRequestKey" });
  const checked = checkGroupInquiry(body.value);
  if (!checked.ok) return groupInquiryError("INPUT_INVALID", { field: checked.problem });

  try {
    const result = await inquiries.submit({ ...body.value, clientRequestKey: key });
    return groupInquiryJson(201, { accepted: true, inquiryRef: result.inquiryRef, replyByDate: result.replyByDate });
  } catch (error) {
    if (error instanceof StoreRateLimitedError) return groupInquiryError("RATE_LIMITED", { retryAfterSeconds: error.retryAfterSeconds });
    if (error instanceof StoreValidationError) return groupInquiryError("VALIDATION_ERROR");
    return groupInquiryError("SEND_FAILED");
  }
}
