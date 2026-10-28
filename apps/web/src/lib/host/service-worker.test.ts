import { describe, expect, it, vi } from "vitest";
import { hostServiceWorkerSource } from "./service-worker";

const ORIGIN = "https://experience.example.test";
type Listener = (event: Record<string, unknown>) => void;

/** Runs a worker source against a stand-in `self` and records what it asks of the browser. */
function load(source: string, network: () => Promise<Response> = async () => new Response("page")) {
  const listeners = new Map<string, Listener>();
  const deleted: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
    registration: { unregister: vi.fn(async () => true) },
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
  const lifecycle = async (type: "install" | "activate") => {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)?.({ waitUntil: (value: Promise<unknown>) => pending.push(value) });
    await Promise.all(pending);
  };
  return { listeners, self, caches, deleted, fetch, request, lifecycle };
}

describe("host service worker (HOST_PWA_ENABLED=true)", () => {
  const source = hostServiceWorkerSource(true);

  it("never stores anything and has no push yet", () => {
    expect(source).not.toMatch(/caches\.open|cache\.put|\.put\(|indexedDB|localStorage/);
    expect(source).not.toMatch(/addEventListener\("push"|notificationclick/);
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
