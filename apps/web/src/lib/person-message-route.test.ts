import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";

/** The route behind 「◯◯さんにメッセージを送る」 (#589) against a stubbed experience store. */
const state = vi.hoisted(() => ({
  config: { personMessagesEnabled: true, peoplePagesEnabled: true, japaneseSiteEnabled: true, guestQuestionsEnabled: false, siteUrl: "https://experience.example" },
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ personMessageRepository: () => state.repository }));

import { POST as send } from "@/app/api/public/people/[slug]/messages/route";

const ORIGIN = "https://experience.example";
const KEY = "00000000-0000-4000-8000-000000000589";
const MESSAGE = { message: "はじめまして。お話を聞かせてください。", guestName: "山田 花子", guestEmail: "hanako@example.com", clientRequestKey: KEY };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/public/people/takuya/messages`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (slug = "takuya") => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  state.config = { personMessagesEnabled: true, peoplePagesEnabled: true, japaneseSiteEnabled: true, guestQuestionsEnabled: false, siteUrl: ORIGIN };
  state.repository = { submitPersonMessage: vi.fn(async () => ({ status: "received" })) };
});

describe("POST /api/public/people/[slug]/messages", () => {
  it("keeps the message for the person's page in the store, as a Japanese guest's, with no-store headers", async () => {
    const response = await send(post(MESSAGE), params());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.repository?.submitPersonMessage).toHaveBeenCalledWith({ personSlug: "takuya", ...MESSAGE, language: "JA" });
  });

  it("is a 404 without its flag or the Japanese site, a 503 without the DB and a 403 from another site", async () => {
    state.config = { ...state.config, personMessagesEnabled: false };
    expect((await send(post(MESSAGE), params())).status).toBe(404);
    // "Ask the host" on the English pages is another flag: it does not open this.
    state.config = { ...state.config, personMessagesEnabled: false, guestQuestionsEnabled: true };
    expect((await send(post(MESSAGE), params())).status).toBe(404);
    state.config = { ...state.config, personMessagesEnabled: true, guestQuestionsEnabled: false, japaneseSiteEnabled: false };
    expect((await send(post(MESSAGE), params())).status).toBe(404);
    // Closed while the people pages are off (#612): there is no page to send it from.
    state.config = { ...state.config, japaneseSiteEnabled: true, peoplePagesEnabled: false };
    expect((await send(post(MESSAGE), params())).status).toBe(404);
    state.config = { ...state.config, peoplePagesEnabled: true };
    expect((await send(post(MESSAGE), params(""))).status).toBe(404);
    state.repository = null;
    expect((await send(post(MESSAGE), params())).status).toBe(503);
    state.repository = { submitPersonMessage: vi.fn() };
    for (const headers of [{ origin: "https://other.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect((await send(post(MESSAGE, headers), params())).status).toBe(403);
    }
    expect(state.repository.submitPersonMessage).not.toHaveBeenCalled();
  });

  it("names the field to fix, and stores nothing the form would not have sent", async () => {
    for (const [change, field] of [
      [{ message: "あ" }, "message"], [{ message: "   " }, "message"], [{ message: "あ".repeat(1001) }, "message"],
      [{ guestName: "  " }, "guestName"], [{ guestEmail: "nope" }, "guestEmail"], [{ clientRequestKey: "short" }, "clientRequestKey"],
    ] as const) {
      const response = await send(post({ ...MESSAGE, ...change }), params());
      expect(response.status, JSON.stringify(change)).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: "INPUT_INVALID", field });
    }
    expect((await send(post({ ...MESSAGE, message: 5 }), params())).status).toBe(422);
    expect((await send(post("not json"), params())).status).toBe(400);
    expect((await send(post({ ...MESSAGE, message: "あ".repeat(33_000) }), params())).status).toBe(413);
    expect(state.repository?.submitPersonMessage).not.toHaveBeenCalled();
  });

  it("answers a person who is not shown as not found, a rate limit with Retry-After and any other failure as retryable", async () => {
    state.repository!.submitPersonMessage!.mockRejectedValueOnce(new StoreNotFoundError("person"));
    const missing = await send(post(MESSAGE), params("nobody"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    state.repository!.submitPersonMessage!.mockRejectedValueOnce(new StoreRateLimitedError(90));
    const limited = await send(post(MESSAGE), params());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("90");
    state.repository!.submitPersonMessage!.mockRejectedValueOnce(new StoreValidationError("x"));
    expect((await send(post(MESSAGE), params())).status).toBe(400);
    state.repository!.submitPersonMessage!.mockRejectedValueOnce(new Error("connection lost"));
    const failed = await send(post(MESSAGE), params());
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("connection");
  });
});
