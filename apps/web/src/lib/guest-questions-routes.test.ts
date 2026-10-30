import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";

/** The public routes of 予約前の質問 against a stubbed experience store (#105). */
const state = vi.hoisted(() => ({
  config: { guestQuestionsEnabled: true, siteUrl: "https://experience.example" },
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestQuestionRepository: () => state.repository }));

import { POST as ask } from "@/app/api/public/experiences/[slug]/questions/route";
import { POST as reply } from "@/app/api/public/questions/reply/route";
import { POST as open } from "@/app/api/public/questions/reply/open/route";

const ORIGIN = "https://experience.example";
const TOKEN = "sample-token-".padEnd(43, "x");
const KEY = "00000000-0000-4000-8000-000000000105";
const QUESTION = { topic: "FOOD", message: "Is there a vegetarian option?", guestName: "Sample Guest", guestEmail: "guest@example.com", clientRequestKey: KEY };

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const slugParams = (slug = "sample-tea") => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  state.config = { guestQuestionsEnabled: true, siteUrl: ORIGIN };
  state.repository = {
    submitQuestion: vi.fn(async () => ({ status: "received" })),
    openReplyLink: vi.fn(async () => ({
      experienceTitle: "Synthetic tea",
      hostDisplayName: "Sample Seller",
      guestName: "Sample Guest",
      messages: [{ from: "guest", atUtc: "2026-10-31T01:00:00.000Z", body: "Is there a vegetarian option?" }],
      expiresAtUtc: "2026-11-14T01:00:00.000Z",
    })),
    submitGuestReply: vi.fn(async () => ({ status: "received" })),
  };
});

describe("POST /api/public/experiences/[slug]/questions", () => {
  it("keeps the question in the store and answers the AskHost contract, with no-store headers", async () => {
    const response = await ask(post("/api/public/experiences/sample-tea/questions", QUESTION), slugParams());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.repository?.submitQuestion).toHaveBeenCalledWith({ productSlug: "sample-tea", ...QUESTION });
  });

  it("is a 404 while the flag is off and a 503 without the DB", async () => {
    state.config = { ...state.config, guestQuestionsEnabled: false };
    expect((await ask(post("/api/public/experiences/sample-tea/questions", QUESTION), slugParams())).status).toBe(404);
    state.config = { ...state.config, guestQuestionsEnabled: true };
    state.repository = null;
    const closed = await ask(post("/api/public/experiences/sample-tea/questions", QUESTION), slugParams());
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: { code: "SEND_FAILED", message: expect.any(String), retryable: true, field: null } });
  });

  it("refuses posts from other sites", async () => {
    const refused: Record<string, string>[] = [{ origin: "https://other.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of refused) {
      expect((await ask(post("/api/public/experiences/sample-tea/questions", QUESTION, headers), slugParams())).status).toBe(403);
    }
    expect(state.repository?.submitQuestion).not.toHaveBeenCalled();
  });

  it("names the field to fix, and refuses bodies that are not a small JSON object", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...QUESTION, clientRequestKey: "short" }, "clientRequestKey"],
      [{ ...QUESTION, topic: "PRICE" }, "topic"],
      [{ ...QUESTION, message: "Hi" }, "message"],
      [{ ...QUESTION, guestName: " " }, "guestName"],
      [{ ...QUESTION, guestEmail: "not-an-address" }, "guestEmail"],
    ];
    for (const [body, field] of cases) {
      const response = await ask(post("/api/public/experiences/sample-tea/questions", body), slugParams());
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: "INPUT_INVALID", field });
    }
    expect((await ask(post("/api/public/experiences/sample-tea/questions", "[]"), slugParams())).status).toBe(400);
    expect((await ask(post("/api/public/experiences/sample-tea/questions", "{"), slugParams())).status).toBe(400);
    expect((await ask(post("/api/public/experiences/sample-tea/questions", QUESTION, { "content-type": "text/plain" }), slugParams())).status).toBe(400);
    const large = await ask(post("/api/public/experiences/sample-tea/questions", { ...QUESTION, padding: "x".repeat(17 * 1024) }), slugParams());
    expect(large.status).toBe(413);
    expect(state.repository?.submitQuestion).not.toHaveBeenCalled();
  });

  it("maps the store's answers: unknown experience, rate limit, invalid input and failures", async () => {
    const submit = state.repository!.submitQuestion!;
    submit.mockRejectedValueOnce(new StoreNotFoundError("published experience"));
    const missing = await ask(post("/api/public/experiences/sample-tea/questions", QUESTION), slugParams());
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    submit.mockRejectedValueOnce(new StoreRateLimitedError(120));
    const limited = await ask(post("/api/public/experiences/sample-tea/questions", QUESTION), slugParams());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("120");
    expect((await limited.json()).error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    submit.mockRejectedValueOnce(new StoreValidationError("synthetic"));
    expect((await ask(post("/api/public/experiences/sample-tea/questions", QUESTION), slugParams())).status).toBe(400);
    submit.mockRejectedValueOnce(new Error("synthetic outage"));
    expect((await ask(post("/api/public/experiences/sample-tea/questions", QUESTION), slugParams())).status).toBe(503);
  });
});

describe("POST /api/public/questions/reply/open and /reply", () => {
  it("opens a link from the body only and says nothing about why a link is closed", async () => {
    const opened = await open(post("/api/public/questions/reply/open", { token: TOKEN }));
    expect(opened.status).toBe(200);
    expect((await opened.json()).link.guestName).toBe("Sample Guest");
    expect(state.repository?.openReplyLink).toHaveBeenCalledWith(TOKEN);
    state.repository!.openReplyLink!.mockResolvedValueOnce(null);
    expect((await open(post("/api/public/questions/reply/open", { token: TOKEN }))).status).toBe(404);
    expect((await open(post("/api/public/questions/reply/open", { token: "short" }))).status).toBe(404);
    expect((await open(post("/api/public/questions/reply/open", { token: TOKEN }, { origin: "https://other.example" }))).status).toBe(403);
  });

  it("takes the answer once and tells a used link from a closed one", async () => {
    const body = { token: TOKEN, message: "Thank you!", clientRequestKey: KEY };
    expect((await reply(post("/api/public/questions/reply", body))).status).toBe(201);
    expect(state.repository?.submitGuestReply).toHaveBeenCalledWith(TOKEN, { message: "Thank you!", clientRequestKey: KEY });
    const submit = state.repository!.submitGuestReply!;
    submit.mockRejectedValueOnce(new StoreConflictError("used"));
    const used = await reply(post("/api/public/questions/reply", body));
    expect(used.status).toBe(409);
    expect((await used.json()).error.code).toBe("LINK_USED");
    submit.mockRejectedValueOnce(new StoreNotFoundError("reply link"));
    expect((await reply(post("/api/public/questions/reply", body))).status).toBe(404);
    expect((await reply(post("/api/public/questions/reply", { ...body, message: " " }))).status).toBe(422);
    expect((await reply(post("/api/public/questions/reply", { ...body, message: "x".repeat(1001) }))).status).toBe(422);
    expect((await reply(post("/api/public/questions/reply", { ...body, clientRequestKey: 7 }))).status).toBe(422);
    state.config = { ...state.config, guestQuestionsEnabled: false };
    expect((await reply(post("/api/public/questions/reply", body))).status).toBe(404);
    expect((await open(post("/api/public/questions/reply/open", { token: TOKEN }))).status).toBe(404);
  });
});
