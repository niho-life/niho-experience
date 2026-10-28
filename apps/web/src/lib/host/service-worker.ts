import { HOST_APP_SCOPE } from "./routes";

/**
 * /host/sw.js (#177, docs/host-pwa.md). It answers page loads under the app's scope from the
 * network and shows a fixed offline page when there is none. It never uses Cache Storage, so no
 * booking, guest, message or sales page is kept on the device, and it stays out of the sign-in and
 * Google round trips and the API relay. P2 adds push here.
 */
export const HOST_SW_PASSTHROUGH = ["/host/auth", "/host/calendar/google", "/host/api"] as const;

/** Self-contained (no request can succeed offline): inline style, a reload button, nothing else. */
const OFFLINE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>接続できません | NIHO 体験ホスト</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#1c1c1a;font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;line-height:1.6}
main{width:100%;max-width:36rem;padding:4rem 1rem;box-sizing:border-box}
h1{margin:0;font-size:1.5rem;line-height:1.3}
p{margin:.75rem 0 2rem;color:#4b4b47}
button{min-height:3rem;padding:0 1.5rem;border:0;border-radius:999px;background:#b2d67c;color:#1c1c1a;font:inherit;font-weight:700;cursor:pointer}
button:hover{background:#a3c86b}
button:focus-visible{outline:3px solid #355e1f;outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>インターネットに接続できません</h1>
<p>通信の状態を確かめて、もう一度読み込んでください。</p>
<button type="button" onclick="location.reload()">再読み込み</button>
</main>
</body>
</html>
`;

const OFFLINE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

const ENABLED = `"use strict";
// NIHO 体験ホスト (#177). No Cache Storage: nothing the host sees is kept on the device.
const SCOPE = ${JSON.stringify(HOST_APP_SCOPE)};
const PASSTHROUGH = ${JSON.stringify(HOST_SW_PASSTHROUGH)};
const OFFLINE_HTML = ${JSON.stringify(OFFLINE_HTML)};
const OFFLINE_HEADERS = ${JSON.stringify(OFFLINE_HEADERS)};

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (PASSTHROUGH.some((path) => url.pathname === path || url.pathname.startsWith(path + "/"))) return;
  event.respondWith(fetch(request).catch(() => new Response(OFFLINE_HTML, { status: 503, headers: OFFLINE_HEADERS })));
});
`;

const DISABLED = `"use strict";
// HOST_PWA_ENABLED=false (#177): this version removes itself. Pages load from the network as before.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister());
});
`;

export function hostServiceWorkerSource(enabled: boolean): string {
  return enabled ? ENABLED : DISABLED;
}
