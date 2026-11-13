import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { hostInvitations } from "@/lib/experience/store-server";
import { isOpaqueSecret, linkBindingHash, newLinkBinding, nowUtc, readSingleFieldForm, setInviteBindingCookie } from "@/lib/host/accounts";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_AUTH_ERROR_PATH, HOST_INVITE_PATH, HOST_LOGIN_PATH, withQuery } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, siteOrigin } from "@/lib/host/server";
import { INVITE_BINDING_COOKIE } from "@/lib/host/session";

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

/** What the page may send the host to, by the reason the store gave: the same words as the error page's. */
const REASONS = { expired: "invite-expired", used: "invite-used", "other-browser": "invite-browser", invalid: "invite-invalid" } as const;

/**
 * The page the invitation email's link opens: `/host/auth/invite#t=<token>` (Epic #591, #596). The token is in the fragment, which
 * never reaches a server, a log or a Referer. The inline script takes it out of the address bar first, then posts it to this
 * path (`referrerPolicy: same-origin`). The answer is 204 with the browser's binding cookie, after which the page goes to the
 * NIHO sign-in (`/host/auth/login?invite=1`), or 400 with why the link cannot be used, which goes to the page that says it.
 * A scanner that runs the page opens the invitation in the scanner's browser, which is not the host's: the host's own browser
 * is then told `other-browser`, and ops invites again (the cost of a link that opens by itself).
 */
function invitePage(): string {
  const login = JSON.stringify(withQuery(HOST_LOGIN_PATH, { invite: "1" }));
  const error = JSON.stringify(`${HOST_AUTH_ERROR_PATH}?reason=`);
  const reasons = JSON.stringify(Object.values(REASONS));
  const script = `(()=>{const t=new URLSearchParams(location.hash.slice(1)).get("t");`
    + `if(location.hash)history.replaceState(history.state,"",location.pathname+location.search);`
    + `const s=document.getElementById("status"),b=document.getElementById("retry");`
    + `const stop=(r)=>location.replace(${error}+encodeURIComponent(r));`
    + `if(!t||!/^[A-Za-z0-9_-]{43}$/.test(t))return stop("invite-invalid");`
    + `const failed=()=>{s.textContent="進めませんでした。通信の状態を確かめて、もう一度お試しください。リンクはまだ使えます。";b.hidden=false;};`
    + `const open=()=>{b.hidden=true;s.textContent="招待を確かめています…";`
    + `fetch(${JSON.stringify(HOST_INVITE_PATH)},{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"t="+t,`
    + `credentials:"same-origin",cache:"no-store",redirect:"error",referrerPolicy:"same-origin"})`
    + `.then((r)=>{if(r.status===204)return location.replace(${login});`
    + `if(r.status===400)return r.json().then((j)=>stop(${reasons}.includes(j&&j.reason)?j.reason:"invite-invalid"),()=>stop("invite-invalid"));failed();},failed);};`
    + `b.addEventListener("click",open);open();})();`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>招待 | NIHO Experience ホスト</title>
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
<h1>NIHO 体験ホストへの招待</h1>
<p id="status" role="status">招待を確かめています…</p>
<button id="retry" type="button" hidden>もう一度試す</button>
<noscript><p>このページは JavaScript で進みます。ブラウザの設定で JavaScript を有効にして、もう一度リンクを開いてください。</p></noscript>
</main>
<script>${script}</script>
</body>
</html>`;
}

export function GET(): Response {
  if (!config.hostConsoleEnabled || !config.hostAccountsEnabled || !config.hostNihoLoginEnabled) return hostNotFound();
  return new Response(invitePage(), { status: 200, headers: PAGE_HEADERS });
}

/**
 * Opens an invitation from the emailed link (`t=<token>`): the browser that does so first is the one it belongs to (its
 * binding cookie, whose SHA-256 the store keeps). On success: the binding cookie (the browser's own one again when it opens the
 * link a second time) and 204; otherwise 400 with `{ reason }`, the invitation's words for why it cannot be used.
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled || !config.hostAccountsEnabled || !config.hostNihoLoginEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const form = await readSingleFieldForm(request, "t", MAX_FORM_BYTES);
  if (!form.ok) return form.status === 400 ? noStoreJson({ reason: REASONS.invalid }, 400) : noStoreJson({ error: form.status === 413 ? "payload_too_large" : "unsupported_media_type" }, form.status);
  if (!isOpaqueSecret(form.value)) return noStoreJson({ reason: REASONS.invalid }, 400);
  const store = hostInvitations();
  if (!store) return noStoreJson({ error: "unavailable" }, 503);

  const existing = request.cookies.get(INVITE_BINDING_COOKIE)?.value;
  const binding = isOpaqueSecret(existing) ? existing : newLinkBinding();
  let opened;
  try {
    opened = await store.openInvitation({ token: form.value, browserBindingHash: linkBindingHash(binding), nowUtc: nowUtc() });
  } catch (error) {
    console.error(`[host-auth] invitation not opened: ${error instanceof Error ? error.name : "unknown error"}`);
    return noStoreJson({ error: "unavailable" }, 503);
  }
  if (opened.kind !== "opened") return noStoreJson({ reason: REASONS[opened.kind] }, 400);
  const response = new NextResponse(null, { status: 204, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
  setInviteBindingCookie(response, binding);
  return response;
}
