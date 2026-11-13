import { STRIPE_DASHBOARD_URL } from "@/host/payout";
import { hostStripeLoginUrl, hostStripeReauthHref } from "@/host/stripe-login-server";
import { config } from "@/lib/config";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { nihoIdOrNull } from "@/lib/host/providers";
import { hostNotFound, noStoreJson, siteOrigin } from "@/lib/host/server";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 512;

class FormBodyTooLarge extends Error {}

/** Reads a small urlencoded form without buffering an unbounded request body. */
async function readFormBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new FormBodyTooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new FormBodyTooLarge();
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* Keep the parse/size error authoritative. */ }
    finally { reader.releaseLock(); }
  }
}

function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : "unknown";
}

function redirectToStripe(url: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: url,
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * The login-link API creates a one-time bearer URL. Only same-origin POSTs can create one; the
 * browser receives it only as a no-store redirect and never as JSON, page data, or a log value.
 */
export async function POST(request: Request): Promise<Response> {
  if (!config.hostConsoleEnabled || config.apiMode !== "http") return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return noStoreJson({ error: "invalid_content_type" }, 415);
  }

  let text: string;
  try {
    text = await readFormBody(request);
  } catch (error) {
    return noStoreJson({ error: error instanceof FormBodyTooLarge ? "payload_too_large" : "invalid_input" }, error instanceof FormBodyTooLarge ? 413 : 400);
  }
  const fields = [...new URLSearchParams(text).entries()];
  const providerId = fields.length === 1 && fields[0]?.[0] === "providerId" ? nihoIdOrNull(fields[0][1]) : null;
  if (!providerId) return noStoreJson({ error: "invalid_input" }, 400);

  try {
    // A host signed in with a bound NIHO account, whose sign-in is too old: NIHO again, then back to 受取口座.
    const reauth = await hostStripeReauthHref(providerId);
    if (reauth) return redirectToStripe(reauth);
    const url = await hostStripeLoginUrl(providerId);
    return redirectToStripe(url ?? STRIPE_DASHBOARD_URL);
  } catch (error) {
    // The Stripe URL and response text are bearer material and must never be logged.
    console.error("Experience host Stripe login link failed", { error: errorClass(error) });
    return redirectToStripe(STRIPE_DASHBOARD_URL);
  }
}
