import { describe, expect, it, vi } from "vitest";
import { hostServiceWorkerSource } from "./service-worker";

const ORIGIN = "https://experience.example.test";
type Listener = (event: Record<string, unknown>) => void;

interface FakeWindow {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

const windowAt = (path: string, navigate: () => Promise<unknown> = async () => undefined): FakeWindow => ({
  url: `${ORIGIN}${path}`, focus: vi.fn(async () => undefined), navigate: vi.fn(navigate), postMessage: vi.fn(),
});

/** Runs a worker source against a stand-in `self` and records what it asks of the browser. */
function load(source: string, network: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => new Response("page"), open: FakeWindow[] = []) {
  const listeners = new Map<string, Listener>();
  const deleted: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => open), openWindow: vi.fn(async () => null) },
    registration: {
      unregister: vi.fn(async () => true),
      showNotification: vi.fn(async () => undefined),
      pushManager: { subscribe: vi.fn(async () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } }) })) },
    },
    navigator: { setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) },
  };
  const caches = { keys: vi.fn(async () => ["old-pages"]), delete: vi.fn(async (key: string) => deleted.push(key) > 0) };
  const fetch = vi.fn(network);
  new Function("self", "caches", "fetch", "Response", "URL", source)(self, caches, fetch, Response, URL);

  /** A request's fate: what the page got, or null when the worker left it to the browser. */
  const request = (path: string, init: { mode?: string; method?: string; origin?: string } = {}) => {
    let answer: Promise<Response> | null = null;
    listeners.get("fetch")?.({ request: { mode: init.mode ?? "navigate", method: init.method ?? "GET", url: `${init.origin ?? ORIGIN}${path}` }, respondWith: (value: Promise<Response>) => { answer = value; } });
    return answer as Promise<Response> | null;
  };
  /** Fires an event and waits for what it handed to waitUntil. */
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (value: Promise<unknown>) => pending.push(value) });
    await Promise.all(pending);
  };
  const lifecycle = (type: "install" | "activate") => dispatch(type);
  return { listeners, self, caches, deleted, fetch, request, lifecycle, dispatch };
}

/** A push whose data is this JSON (or this raw text). */
const pushOf = (data: unknown) => ({ data: { json: () => (typeof data === "string" ? JSON.parse(data) : data) } });

describe("host service worker (HOST_PWA_ENABLED=true)", () => {
  const source = hostServiceWorkerSource(true);

  it("never stores anything", () => {
    expect(source).not.toMatch(/caches\.|cache\.put|\.put\(|indexedDB|localStorage/);
  });

  it("takes over at once and leaves the origin's caches alone (the traveler site shares the origin)", async () => {
    const worker = load(source);
    await worker.lifecycle("install");
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
    await worker.lifecycle("activate");
    expect(worker.caches.keys).not.toHaveBeenCalled();
    expect(worker.deleted).toEqual([]);
    expect(worker.self.clients.claim).toHaveBeenCalledOnce();
  });

  it("answers console page loads from the network", async () => {
    const worker = load(source);
    for (const path of ["/host/home", "/host/bookings?filter=pending", "/host/calendar", "/host/launch?source=pwa"]) {
      const answer = worker.request(path);
      expect(answer, path).not.toBeNull();
      expect(await (await answer!).text()).toBe("page");
    }
    expect(worker.fetch).toHaveBeenCalledTimes(4);
  });

  it("leaves sign-in, Google, the API relay, other pages and anything but a page load to the browser", () => {
    const worker = load(source);
    for (const path of ["/host/auth/login", "/host/auth/callback?code=x", "/host/auth", "/host/calendar/google", "/host/calendar/google/callback", "/host/api/experience-providers", "/host", "/", "/experiences"]) {
      expect(worker.request(path), path).toBeNull();
    }
    expect(worker.request("/host/home", { mode: "cors" })).toBeNull();
    expect(worker.request("/host/home", { mode: "no-cors" })).toBeNull();
    expect(worker.request("/host/home", { method: "POST" })).toBeNull();
    expect(worker.request("/host/home", { origin: "https://niho.example.test" })).toBeNull();
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("shows a self-contained offline page when the network fails", async () => {
    const worker = load(source, async () => Promise.reject(new TypeError("offline")));
    const response = await worker.request("/host/messages")!;
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("再読み込み");
    expect(html).not.toMatch(/\s(src|href)=|url\(|@import/);
  });
});

describe("host service worker: push (#177 P2)", () => {
  const source = hostServiceWorkerSource(true);
  const message = { v: 1, title: "新しい予約・申込", body: "Kamakura Community Dinner · 10/22（木）18:00 · 3名", url: "/host/bookings?filter=pending", tag: "booking-1" };

  it("shows the push as a notification that opens its page, sets the app badge and tells open pages", async () => {
    const page = windowAt("/host/home");
    const worker = load(source, undefined, [page]);
    await worker.dispatch("push", pushOf({ ...message, badge: 3 }));
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith("新しい予約・申込", {
      body: message.body, tag: "booking-1", data: { url: `${ORIGIN}/host/bookings?filter=pending` }, icon: "/host-app/icon-192.png",
    });
    expect(worker.self.navigator.setAppBadge).toHaveBeenCalledWith(3);
    expect(page.postMessage).toHaveBeenCalledWith({ type: "niho-host-push" });
    await worker.dispatch("push", pushOf({ ...message, badge: 0 }));
    expect(worker.self.navigator.clearAppBadge).toHaveBeenCalledOnce();
  });

  it("turns pushes it cannot read or that would lead out of the app into a plain notice for ホーム", async () => {
    const worker = load(source);
    await worker.dispatch("push", { data: { json: () => { throw new SyntaxError("bad"); } } });
    await worker.dispatch("push", { data: null });
    await worker.dispatch("push", pushOf({ ...message, v: 2 }));
    for (const url of ["https://evil.example.test/host/home", "//evil.example.test/host/", "/experiences", "/host", 42]) await worker.dispatch("push", pushOf({ ...message, url }));
    const shown = worker.self.registration.showNotification.mock.calls as unknown as [string, unknown][];
    expect(shown).toHaveLength(8);
    for (const [title, options] of shown) {
      expect(title).toBe("NIHO 体験ホストにお知らせがあります");
      expect(options).toEqual({ data: { url: `${ORIGIN}/host/home` }, icon: "/host-app/icon-192.png" });
    }
  });

  it("a tap brings an open console window to the page, or opens one", async () => {
    const notification = (url: unknown) => ({ notification: { close: vi.fn(), data: { url } } });
    const page = windowAt("/host/settings");
    const traveler = windowAt("/experiences");
    const worker = load(source, undefined, [traveler, page]);
    const tap = notification(`${ORIGIN}/host/messages?thread=t1`);
    await worker.dispatch("notificationclick", tap);
    expect(tap.notification.close).toHaveBeenCalledOnce();
    expect(page.focus).toHaveBeenCalledOnce();
    expect(page.navigate).toHaveBeenCalledWith(`${ORIGIN}/host/messages?thread=t1`);
    expect(traveler.navigate).not.toHaveBeenCalled();
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled();

    const closed = load(source, undefined, [traveler]);
    await closed.dispatch("notificationclick", notification("https://evil.example.test/"));
    expect(closed.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/host/home`);

    const uncontrolled = load(source, undefined, [windowAt("/host/home", async () => { throw new TypeError("not controlled"); })]);
    await uncontrolled.dispatch("notificationclick", notification(`${ORIGIN}/host/calendar`));
    expect(uncontrolled.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/host/calendar`);
  });

  it("re-subscribes with the same key when the browser replaces the subscription, and drops the old endpoint", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const worker = load(source, async (input, init) => { sent.push({ url: String(input), init: init ?? {} }); return new Response(null, { status: 200 }); });
    const key = new Uint8Array([4, 1, 2]);
    await worker.dispatch("pushsubscriptionchange", { oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/old", options: { applicationServerKey: key } } });
    expect(worker.self.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
    expect(sent.map(({ url, init }) => [url, init.method, init.credentials, init.body])).toEqual([
      ["/host/api/push-subscriptions", "POST", "same-origin", JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } })],
      ["/host/api/push-subscriptions", "DELETE", "same-origin", JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/old" })],
    ]);
  });
});

describe("host service worker (HOST_PWA_ENABLED=false)", () => {
  const source = hostServiceWorkerSource(false);

  it("replaces an installed worker and removes itself, leaving every request to the browser", async () => {
    const worker = load(source);
    expect(worker.listeners.has("fetch")).toBe(false);
    await worker.lifecycle("install");
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
    await worker.lifecycle("activate");
    expect(worker.self.registration.unregister).toHaveBeenCalledOnce();
    expect(source).not.toMatch(/caches\.open|cache\.put/);
  });
});
