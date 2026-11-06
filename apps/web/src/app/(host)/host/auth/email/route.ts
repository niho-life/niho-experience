import type { NextRequest } from "next/server";
import { StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostAccounts } from "@/lib/experience/store-server";
import { isOpaqueSecret, linkBindingHash, newLinkBinding, nowUtc, readSingleFieldForm, setLinkBindingCookie } from "@/lib/host/accounts";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_EMAIL_SIGN_IN_PATH, withQuery } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, seeOther, siteOrigin } from "@/lib/host/server";
import { LINK_BINDING_COOKIE } from "@/lib/host/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The form holds one address (at most 254 characters, percent-encoded). */
const MAX_FORM_BYTES = 1024;

/**
 * 「ログインのリンクを送る」 (ADR 0003, docs/host-accounts.md): the email form's POST. The store queues a link for an ACTIVE
 * account under its limits (5 an hour, 30 seconds apart) and the mail job sends it, so no email goes out while the host
 * waits. The answer is the same 303 to 「メールを確認してください」 whether or not the address has an account, is
 * suspended or reached a limit; only something that is not an address is sent back to the form. The link is bound to
 * this browser: the SHA-256 of a random value kept in an HttpOnly cookie on /host/auth for 15 minutes. A browser that
 * already holds one keeps it, so every link it asked for in that time opens here. The address is never logged.
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled || !config.hostAccountsEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const form = await readSingleFieldForm(request, "email", MAX_FORM_BYTES);
  if (!form.ok) return noStoreJson({ error: form.status === 413 ? "payload_too_large" : form.status === 415 ? "unsupported_media_type" : "invalid_input" }, form.status);
  const store = hostAccounts();
  if (!store) return seeOther(withQuery(HOST_EMAIL_SIGN_IN_PATH, { error: "unavailable" }));

  const held = request.cookies.get(LINK_BINDING_COOKIE)?.value;
  const binding = isOpaqueSecret(held) ? held : newLinkBinding();
  try {
    await store.requestLogin({ email: form.value, browserBindingHash: linkBindingHash(binding), nowUtc: nowUtc() });
  } catch (error) {
    if (error instanceof StoreValidationError) return seeOther(withQuery(HOST_EMAIL_SIGN_IN_PATH, { error: "email" }));
    console.error(`[host-auth] sign-in link not requested: ${error instanceof Error ? error.name : "unknown error"}`);
    return seeOther(withQuery(HOST_EMAIL_SIGN_IN_PATH, { error: "unavailable" }));
  }
  const response = seeOther(withQuery(HOST_EMAIL_SIGN_IN_PATH, { sent: "1" }));
  setLinkBindingCookie(response, binding);
  return response;
}
