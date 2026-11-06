import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { hostAccounts } from "@/lib/experience/store-server";
import { clearLinkBindingCookie, isOpaqueSecret, linkBindingHash, nowUtc, readSingleFieldForm, setAccountSessionCookie } from "@/lib/host/accounts";
import { forgetHostPushConnection } from "@/lib/host/push/server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_AUTH_ERROR_PATH, HOST_HOME_PATH, HOST_LOGIN_LINK_PATH, withQuery } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, siteOrigin } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, LINK_BINDING_COOKIE } from "@/lib/host/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `t=<43 characters>`, percent-encoded at most. */
const MAX_FORM_BYTES = 256;

/** next.config.ts sends the same for this path (its headers win over a route's own). */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

/**
 * The page the emailed link opens: `/host/auth/open#t=<token>`. The token is in the fragment, which never reaches a
 * server, a log or a Referer. The inline script takes it out of the address bar first, then posts it to this path
 * (`referrerPolicy: same-origin`, so the request carries this site's Origin under the page's no-referrer policy). The
 * answer to the post is 204 with the session cookie, after which the page moves into the console, or 400 for a link
 * that cannot be used, which goes to the page that says why. A plain 204 (not a redirect the script cannot read) keeps
 * the cookie on an ordinary response in every browser. A scanner that runs the page has not got the browser's link cookie,
 * so it opens nothing, and the link still works in the browser that asked for it.
 */
function linkPage(): string {
  const script = `(()=>{const t=new URLSearchParams(location.hash.slice(1)).get("t");`
    + `if(location.hash)history.replaceState(history.state,"",location.pathname+location.search);`
    + `const s=document.getElementById("status"),b=document.getElementById("retry");`
    + `const closed=()=>location.replace(${JSON.stringify(withQuery(HOST_AUTH_ERROR_PATH, { reason: "link" }))});`
    + `if(!t||!/^[A-Za-z0-9_-]{43}$/.test(t))return closed();`
    + `const failed=()=>{s.textContent="ログインできませんでした。通信の状態を確かめて、もう一度お試しください。リンクはまだ使えます。";b.hidden=false;};`
    + `const open=()=>{b.hidden=true;s.textContent="ログインしています…";`
    + `fetch(${JSON.stringify(HOST_LOGIN_LINK_PATH)},{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"t="+t,`
    + `credentials:"same-origin",cache:"no-store",redirect:"error",referrerPolicy:"same-origin"})`
    + `.then((r)=>{if(r.status===204)return location.replace(${JSON.stringify(HOST_HOME_PATH)});`
    + `if(r.status===400)return closed();failed();},failed);};`
    + `b.addEventListener("click",open);open();})();`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>ログイン | NIHO Experience ホスト</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;background:#ffffff;color:#1c1c1a;line-height:1.6}
main{max-width:36rem;margin:0 auto;padding:4rem 1rem}
h1{font-size:1.5rem;margin:0 0 .75rem}
p{margin:0 0 1rem;color:#4b4b47}
button{min-height:3rem;padding:0 1.5rem;border:0;border-radius:999px;background:#b2d67c;color:#1c1c1a;font:inherit;font-weight:800;cursor:pointer}
</style>
</head>
<body>
<main id="main">
<h1>NIHO 体験ホストにログイン</h1>
<p id="status" role="status">ログインしています…</p>
<button id="retry" type="button" hidden>もう一度試す</button>
<noscript><p>このページは JavaScript でログインします。ブラウザの設定で JavaScript を有効にして、もう一度リンクを開いてください。</p></noscript>
</main>
<script>${script}</script>
</body>
</html>`;
}

export function GET(): Response {
  if (!config.hostConsoleEnabled || !config.hostAccountsEnabled) return hostNotFound();
  return new Response(linkPage(), { status: 200, headers: PAGE_HEADERS });
}

/** Expired, used, unknown, or not this browser's (no link cookie, or another one): the store does not say which. */
const linkInvalid = () => noStoreJson({ error: "link_invalid" }, 400);

/**
 * Opens a session from an emailed link (`t=<token>`), once, in the browser that asked for it (its link cookie). On
 * success: the session cookie (`__Host-`, HttpOnly, Secure, SameSite=Lax, Path=/, no longer than the session), the link
 * cookie cleared, the session this browser held before signed out, and 204 (the page then moves into the console).
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled || !config.hostAccountsEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const form = await readSingleFieldForm(request, "t", MAX_FORM_BYTES);
  if (!form.ok) return form.status === 400 ? linkInvalid() : noStoreJson({ error: form.status === 413 ? "payload_too_large" : "unsupported_media_type" }, form.status);
  const binding = request.cookies.get(LINK_BINDING_COOKIE)?.value;
  if (!isOpaqueSecret(form.value) || !isOpaqueSecret(binding)) return linkInvalid();
  const store = hostAccounts();
  if (!store) return noStoreJson({ error: "unavailable" }, 503);

  const now = Date.now();
  let opened;
  try {
    opened = await store.consumeLogin({ token: form.value, browserBindingHash: linkBindingHash(binding), nowUtc: nowUtc(now) });
  } catch (error) {
    console.error(`[host-auth] sign-in link not opened: ${error instanceof Error ? error.name : "unknown error"}`);
    return noStoreJson({ error: "unavailable" }, 503);
  }
  if (opened.kind !== "ok") return linkInvalid();

  // The session this browser held before ends, with its devices' push (another account on a shared device, or the same
  // host signing in again). Best effort: the new session is open either way.
  const previous = request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value;
  if (isOpaqueSecret(previous) && previous !== opened.sessionToken) {
    try {
      const ended = await store.readSession({ sessionToken: previous, nowUtc: nowUtc(now) });
      await store.revokeSession({ sessionToken: previous, nowUtc: nowUtc(now) });
      if (ended) await forgetHostPushConnection(ended.sessionRef);
    } catch {
      // It ends on its own (14 idle days at most).
    }
  }

  const response = new NextResponse(null, { status: 204, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
  setAccountSessionCookie(response, opened.sessionToken, opened.absoluteExpiresAtUtc, now);
  clearLinkBindingCookie(response);
  return response;
}
