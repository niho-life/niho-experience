import { describe, expect, it, vi } from "vitest";
import { generateVapidKeys } from "@niho-experience/web-push";

vi.mock("server-only", () => ({}));

import { HOST_PUSH_SEEN_WITHIN_MS, notifyHostDevices, type HostPushDeps } from "./notify";
import { HOST_PUSH_TITLES, hostPushDelivery, hostPushPayload, hostPushTestPayload, hostPushTopic, type HostPushEvent } from "./payload";

const event: HostPushEvent = {
  providerId: "sample-provider-kitchen",
  kind: "NEW_BOOKING",
  experienceTitle: "Kamakura Community Dinner with Locals",
  startsAt: "2026-10-22T09:00:00Z",
  seats: 3,
  url: "/host/bookings?filter=pending&booking=bk-2041",
  tag: "booking-bk-2041",
};

describe("hostPushPayload: what a lock screen may show (#177 P2)", () => {
  it("says the kind, the experience, the time in Japan and the party size", () => {
    expect(JSON.parse(hostPushPayload({ ...event, badgeCount: 2 }))).toEqual({
      v: 1,
      title: "新しい予約・申込",
      body: "Kamakura Community Dinner with Locals · 10/22（木）18:00 · 3名",
      url: "/host/bookings?filter=pending&booking=bk-2041",
      tag: "booking-bk-2041",
      badge: 2,
    });
  });

  it("leaves out what it does not know, and has a title for every kind", () => {
    expect(JSON.parse(hostPushPayload({ providerId: "p", kind: "LISTING_REVIEW", url: "/host/experiences", tag: "listing-1" })).body).toBe("");
    expect(JSON.parse(hostPushPayload({ ...event, startsAt: "not a date", seats: 0 })).body).toBe("Kamakura Community Dinner with Locals");
    expect(Object.keys(HOST_PUSH_TITLES)).toEqual(["NEW_BOOKING", "APPROVAL_DEADLINE", "CANCELLATION", "GUEST_MESSAGE", "DAY_BEFORE_SUMMARY", "NEW_REVIEW", "LISTING_REVIEW"]);
  });

  it("carries no names, message text or amounts, even when a caller passes them", () => {
    const smuggled = { ...event, guestName: "合成 予約者", message: "アレルギーがあります", amount: 12000 } as HostPushEvent;
    const json = hostPushPayload(smuggled);
    expect(json).not.toMatch(/合成 予約者|アレルギー|12000|¥/);
  });

  it("opens only pages under /host/, and stays within 3 KB", () => {
    for (const url of ["https://evil.example.test/host/home", "//evil.example.test/host/", "/host", "/experiences", "/host/../admin", "/host\\evil"]) {
      expect(() => hostPushPayload({ ...event, url }), url).toThrow(/under \/host\//);
    }
    const long = JSON.parse(hostPushPayload({ ...event, experienceTitle: "体".repeat(500) }));
    expect(long.body.startsWith(`${"体".repeat(79)}…`)).toBe(true);
    // An emoji at the cut is left out whole, never halved.
    const emoji = JSON.parse(hostPushPayload({ ...event, experienceTitle: `${"a".repeat(78)}🍵Tea` }));
    expect(emoji.body.startsWith(`${"a".repeat(78)}…`)).toBe(true);
    expect(Buffer.byteLength(hostPushPayload({ ...event, experienceTitle: "体".repeat(500) }))).toBeLessThanOrEqual(3 * 1024);
  });

  it("sends time-critical kinds at once and lets deadlines expire", () => {
    expect(hostPushDelivery("NEW_BOOKING")).toEqual({ urgency: "high", ttlSeconds: 86_400 });
    expect(hostPushDelivery("APPROVAL_DEADLINE")).toEqual({ urgency: "high", ttlSeconds: 3_600 });
    expect(hostPushDelivery("GUEST_MESSAGE").urgency).toBe("high");
    expect(hostPushDelivery("CANCELLATION").urgency).toBe("high");
    expect(hostPushDelivery("DAY_BEFORE_SUMMARY")).toEqual({ urgency: "normal", ttlSeconds: 43_200 });
    expect(hostPushDelivery("NEW_REVIEW")).toEqual({ urgency: "normal", ttlSeconds: 86_400 });
    expect(hostPushTopic("booking-bk-2041")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(hostPushTopic("booking-bk-2041")).not.toContain("2041");
    expect(JSON.parse(hostPushTestPayload())).toMatchObject({ v: 1, title: "テスト通知", url: "/host/settings#settings-device" });
  });
});

describe("notifyHostDevices", () => {
  const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
  const device = (id: string) => ({ id, endpoint: `https://fcm.googleapis.com/fcm/send/device-${id}`, ...keys });

  function deps(statuses: Record<string, number | Error>, now = Date.UTC(2026, 9, 28)) {
    const log: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const subscriptions: HostPushDeps["subscriptions"] = {
      recipients: vi.fn(async () => Object.keys(statuses).map(device)),
      recordSent: vi.fn(async (id: string) => { log.push(`sent ${id}`); }),
      recordFailure: vi.fn(async (id: string) => { log.push(`failure ${id}`); }),
      removeById: vi.fn(async (id: string) => { log.push(`removed ${id}`); }),
    };
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const id = String(url).split("device-")[1]!;
      const answer = statuses[id]!;
      if (answer instanceof Error) throw answer;
      expect(new Headers(init?.headers).get("urgency")).toBe("high");
      return new Response(null, { status: answer });
    }) as unknown as typeof globalThis.fetch;
    return { deps: { subscriptions, vapid: { subject: "mailto:host-push@example.test", ...generateVapidKeys() }, fetch, now }, log, peak: () => peak, subscriptions };
  }

  it("sends to the provider's recently seen devices, four at a time, and keeps each result", async () => {
    const run = deps({ 1: 201, 2: 410, 3: 404, 4: 429, 5: 400, 6: new TypeError("offline"), 7: 202 });
    const report = await notifyHostDevices(event, run.deps);
    expect(report).toEqual({ recipients: 7, sent: 2, gone: 2, failed: 3 });
    expect(run.log.sort()).toEqual(["failure 4", "failure 5", "failure 6", "removed 2", "removed 3", "sent 1", "sent 7"]);
    expect(run.peak()).toBeLessThanOrEqual(4);
    expect(run.subscriptions.recipients).toHaveBeenCalledWith("sample-provider-kitchen", new Date(run.deps.now - HOST_PUSH_SEEN_WITHIN_MS));
  });

  it("refuses an event that would leave the app before sending anything", async () => {
    const run = deps({ 1: 201 });
    await expect(notifyHostDevices({ ...event, url: "https://evil.example.test/" }, run.deps)).rejects.toThrow();
    expect(run.subscriptions.recipients).not.toHaveBeenCalled();
  });

  it("does nothing without devices, and survives failed bookkeeping", async () => {
    expect(await notifyHostDevices(event, deps({}).deps)).toEqual({ recipients: 0, sent: 0, gone: 0, failed: 0 });
    const run = deps({ 1: 201 });
    vi.mocked(run.subscriptions.recordSent).mockRejectedValueOnce(new Error("db down"));
    expect(await notifyHostDevices(event, run.deps)).toMatchObject({ sent: 1 });
  });
});
