import { HOST_PUSH_MESSAGE, HOST_SHARE_FIELD, HOST_SHARE_PHOTO_MAX_BYTES, HOST_SHARE_PHOTO_TYPES, HOST_SHARE_TAKE_MESSAGE, HOST_SHARE_WORKER_HOLD_MS } from "./display";
import { HOST_APP_ICONS } from "./pwa";
import { NIHO_SANS_FAMILY, NIHO_SANS_FONT_FACES } from "../niho-sans";
import { HOST_API_PREFIX, HOST_APP_SCOPE, HOST_EXPERIENCES_PATH, HOST_HOME_PATH, HOST_SHARE_TARGET_PATH, HOST_SHARED_QUERY } from "./routes";

/**
 * /host/sw.js (#177, docs/host-pwa.md). It answers page loads under the app's scope from the
 * network and shows a fixed offline page when there is none. It never uses Cache Storage, so no
 * booking, guest, message or sales page is kept on the device, and it stays out of the sign-in and
 * Google round trips and the API relay. P2: it shows pushes (lib/host/push/payload.ts) as
 * notifications that open a page under /host/, and re-subscribes when the browser rotates a subscription.
 * P3: it receives a photo shared from Android's share sheet (manifest `share_target`), keeps it in its own memory
 * for a few minutes (never on the device) and hands it once to the page that follows.
 */
export const HOST_SW_PASSTHROUGH = ["/host/auth", "/host/invitations", "/host/calendar/google", "/host/api"] as const;

/** Self-contained (no request can succeed offline): inline style, a reload button, nothing else. */
const OFFLINE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>接続できません | NIHO 体験ホスト</title>
<style>
${NIHO_SANS_FONT_FACES}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#1c1c1a;font-family:${NIHO_SANS_FAMILY};line-height:1.6}
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
const HOME = ${JSON.stringify(HOST_HOME_PATH)};
const ICON = ${JSON.stringify(HOST_APP_ICONS.icon192)};
const FALLBACK_TITLE = "NIHO 体験ホストにお知らせがあります";
const SUBSCRIPTIONS = ${JSON.stringify(`${HOST_API_PREFIX}push-subscriptions`)};
const PUSH_MESSAGE = ${JSON.stringify(HOST_PUSH_MESSAGE)};
const SHARE_PATH = ${JSON.stringify(HOST_SHARE_TARGET_PATH)};
const SHARE_LANDING = ${JSON.stringify(HOST_EXPERIENCES_PATH)};
const SHARE_QUERY = ${JSON.stringify(HOST_SHARED_QUERY)};
const SHARE_FIELD = ${JSON.stringify(HOST_SHARE_FIELD)};
const SHARE_TYPES = ${JSON.stringify(HOST_SHARE_PHOTO_TYPES)};
const SHARE_MAX_BYTES = ${HOST_SHARE_PHOTO_MAX_BYTES};
const SHARE_HOLD_MS = ${HOST_SHARE_WORKER_HOLD_MS};
const SHARE_TAKE = ${JSON.stringify(HOST_SHARE_TAKE_MESSAGE)};

// A photo shared to the app (P3). It waits here, in this worker's memory only, until the page that follows takes it.
// A worker that was stopped meanwhile has lost it, and the page says so.
let sharedPhoto = null;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // The share sheet posts the photo as a page navigation. This is the only POST the worker answers.
  if (request.method === "POST") {
    if (request.mode === "navigate" && url.origin === self.location.origin && url.pathname === SHARE_PATH) event.respondWith(receiveShare(request));
    return;
  }
  if (request.mode !== "navigate" || request.method !== "GET") return;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (PASSTHROUGH.some((path) => url.pathname === path || url.pathname.startsWith(path + "/"))) return;
  event.respondWith(fetch(request).catch(() => new Response(OFFLINE_HTML, { status: 503, headers: OFFLINE_HEADERS })));
});

// Keeps the first usable photo of a share (the form takes one at a time) and sends the host on to 体験.
async function receiveShare(request) {
  let photo = null;
  try {
    const form = await request.formData();
    photo = form.getAll(SHARE_FIELD).find((value) => value && typeof value === "object" && typeof value.arrayBuffer === "function"
      && SHARE_TYPES.includes(value.type) && value.size > 0 && value.size <= SHARE_MAX_BYTES) || null;
  } catch (error) {
    photo = null;
  }
  sharedPhoto = photo ? { photo, at: Date.now() } : null;
  return Response.redirect(new URL(SHARE_LANDING + "?" + SHARE_QUERY + "=" + (photo ? "photo" : "none"), self.location.origin).href, 303);
}

// The page that follows asks once, over a channel it opens, and the worker forgets the photo as it answers.
self.addEventListener("message", (event) => {
  const data = event.data;
  const port = event.ports && event.ports[0];
  if (!data || data.type !== SHARE_TAKE || !port || !inScope(event.source && event.source.url)) return;
  const held = sharedPhoto && Date.now() - sharedPhoto.at <= SHARE_HOLD_MS ? sharedPhoto.photo : null;
  sharedPhoto = null;
  port.postMessage({ type: SHARE_TAKE, photo: held });
});

// An absolute URL on this site under /host/, or null: a notification never leads out of the app.
function inScope(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && url.pathname.startsWith(SCOPE) ? url.href : null;
  } catch (error) {
    return null;
  }
}

async function windows() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

// What follows any push, however the notification itself came: the app icon's count and a word to the open pages.
async function afterPush(badge) {
  const nav = self.navigator;
  if (typeof badge === "number" && nav && typeof nav.setAppBadge === "function") {
    await (badge > 0 ? nav.setAppBadge(badge) : nav.clearAppBadge()).catch(() => undefined);
  }
  for (const client of await windows()) client.postMessage({ type: PUSH_MESSAGE });
}

self.addEventListener("push", (event) => {
  // A Declarative Web Push with mutable: true (Push API, receiving a push message) arrives with no data and the notification
  // the browser has ready as event.notification. The browser shows it unless this handler shows one, so none is shown here: a
  // generic notice would take its place and the real one (its words, tag and page) would be lost. The app badge is in the
  // notification's data (payload.ts); the open pages are told as for any push.
  const ready = event.notification;
  if (ready && typeof ready === "object") {
    const info = ready.data && typeof ready.data === "object" ? ready.data : null;
    event.waitUntil(afterPush(info && typeof info.badge === "number" ? info.badge : undefined));
    return;
  }
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (error) {
    data = null;
  }
  // A push must always show something: iOS and Chrome withdraw subscriptions that receive silent ones.
  // One that cannot be read, or would lead out of the app, becomes a plain notice that opens ホーム.
  const url = data && data.v === 1 && typeof data.title === "string" ? inScope(data.url) : null;
  if (!url) {
    event.waitUntil(self.registration.showNotification(FALLBACK_TITLE, { data: { url: new URL(HOME, self.location.origin).href }, icon: ICON }));
    return;
  }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url },
      icon: ICON,
    });
    await afterPush(data.badge);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = inScope(data && data.url) || new URL(HOME, self.location.origin).href;
  event.waitUntil((async () => {
    const open = (await windows()).find((client) => inScope(client.url));
    if (open) {
      await open.focus();
      try {
        await open.navigate(url);
        return;
      } catch (error) {
        // A page this worker does not control cannot be moved; open the address instead.
      }
    }
    await self.clients.openWindow(url);
  })());
});

// The browser replaced the subscription: subscribe again with the same key, tell the server, drop the old one.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const previous = event.oldSubscription || null;
    const key = previous && previous.options ? previous.options.applicationServerKey : null;
    const next = event.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
    const send = (method, body) => fetch(SUBSCRIPTIONS, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (next) await send("POST", next);
    if (previous && (!next || previous.endpoint !== next.endpoint)) await send("DELETE", { endpoint: previous.endpoint }).catch(() => undefined);
  })().catch(() => undefined));
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
