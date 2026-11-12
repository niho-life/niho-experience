import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";

/** The public inquiry route (#532) against a stubbed store, and the Admin inbox's BFF with its gates. */
const state = vi.hoisted(() => ({
  config: { groupInquiryEnabled: true, siteUrl: "https://experience.example" },
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
  csrf: true,
  load: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ groupInquiryRepository: () => state.repository }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => true,
    adminMutationAllowed: () => state.csrf,
    loadAdminHttpSession: state.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});

import { POST as submit } from "@/app/api/public/group-inquiries/route";
import { GET as adminList, POST as adminUpdate } from "@/app/(admin)/admin/api/inquiries/route";

const ORIGIN = "https://experience.example";
const KEY = "00000000-0000-4000-8000-000000000532";
const MINIMAL = { clientRequestKey: KEY, kind: "SCHOOL", locale: "ja", name: "山田 花子", email: "teacher@example.com", message: "修学旅行の相談です。" };
const ID = "00000000-0000-4000-8000-000000000533";

function post(body: unknown, headers: Record<string, string> = {}, url = `${ORIGIN}/api/public/group-inquiries`): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { groupInquiryEnabled: true, siteUrl: ORIGIN };
  state.csrf = true;
  state.repository = {
    submit: vi.fn(async () => ({ inquiryRef: "IQ-7K3M9Q2X", repeated: false, replyByDate: "2026-11-17" })),
    list: vi.fn(async () => ({ inquiries: [], counts: { NEW: 0, IN_PROGRESS: 0, DONE: 0 }, today: "2026-11-13" })),
    update: vi.fn(async () => ({ id: ID, status: "DONE" })),
  };
  state.load.mockResolvedValue({ status: "ok", kind: "google", actor: { id: "adm_00000000000000000000000000000001", displayName: null } });
});

describe("POST /api/public/group-inquiries", () => {
  it("keeps an inquiry with only the three required answers and answers received only then, with no-store headers", async () => {
    const response = await submit(post(MINIMAL));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ accepted: true, inquiryRef: "IQ-7K3M9Q2X", replyByDate: "2026-11-17" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.repository!.submit).toHaveBeenCalledWith({ ...MINIMAL, clientRequestKey: KEY });
  });

  it("is a 404 while the flag is off, a 503 without the DB, and a 403 from another site", async () => {
    state.config = { ...state.config, groupInquiryEnabled: false };
    expect((await submit(post(MINIMAL))).status).toBe(404);
    state.config = { ...state.config, groupInquiryEnabled: true };
    state.repository = null;
    const closed = await submit(post(MINIMAL));
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: { code: "SEND_FAILED", retryable: true, field: null } });
    for (const headers of [{ origin: "https://other.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect((await submit(post(MINIMAL, headers))).status).toBe(403);
    }
  });

  it("names the field to fix, and never stores what the form would not have sent", async () => {
    for (const [change, field] of [
      [{ name: "" }, "name"], [{ email: "nope" }, "email"], [{ message: "   " }, "message"], [{ kind: "OTHER" }, "kind"],
      [{ clientRequestKey: "short" }, "clientRequestKey"], [{ details: { payer: "CASH" } }, "details.payer"],
    ] as const) {
      const response = await submit(post({ ...MINIMAL, ...change }));
      expect(response.status, JSON.stringify(change)).toBe(422);
      expect(await response.json()).toEqual({ error: { code: "INPUT_INVALID", retryable: false, field } });
    }
    expect(state.repository!.submit).not.toHaveBeenCalled();
    expect((await submit(post("not json"))).status).toBe(400);
    expect((await submit(post({ ...MINIMAL, message: "あ".repeat(33_000) }))).status).toBe(413);
  });

  it("answers a rate limit with Retry-After, a store refusal as invalid and any other failure as retryable", async () => {
    state.repository!.submit!.mockRejectedValueOnce(new StoreRateLimitedError(90));
    const limited = await submit(post(MINIMAL));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("90");
    state.repository!.submit!.mockRejectedValueOnce(new StoreValidationError("x"));
    expect((await submit(post(MINIMAL))).status).toBe(400);
    state.repository!.submit!.mockRejectedValueOnce(new Error("connection lost"));
    const failed = await submit(post(MINIMAL));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("connection");
  });

  it("answers a repeated submission like the first (one inquiry on the server)", async () => {
    state.repository!.submit!.mockResolvedValueOnce({ inquiryRef: "IQ-7K3M9Q2X", repeated: true, replyByDate: "2026-11-17" });
    const response = await submit(post(MINIMAL));
    expect(response.status).toBe(201);
    expect((await response.json()).inquiryRef).toBe("IQ-7K3M9Q2X");
  });
});

describe("the Admin inbox BFF", () => {
  const url = "https://experience.example/admin/api/inquiries";
  const update = (body: unknown) => adminUpdate(post(body, {}, url));

  it("refuses a read or a change without a signed-in Admin, and reads nothing for them", async () => {
    for (const status of ["signed-out", "rejected", "refresh"]) {
      state.load.mockResolvedValue({ status });
      expect((await adminList(new Request(url))).status).toBe(401);
      expect((await update({ action: "update", id: ID, status: "DONE" })).status).toBe(401);
    }
    state.load.mockResolvedValue({ status: "error" });
    expect((await adminList(new Request(url))).status).toBe(503);
    expect(state.repository!.list).not.toHaveBeenCalled();
    expect(state.repository!.update).not.toHaveBeenCalled();
  });

  it("is a 404 while the flag is off, and a change needs the same-origin check and a JSON body", async () => {
    state.config = { ...state.config, groupInquiryEnabled: false };
    expect((await adminList(new Request(url))).status).toBe(404);
    expect((await update({ action: "update", id: ID, status: "DONE" })).status).toBe(404);
    state.config = { ...state.config, groupInquiryEnabled: true };
    state.csrf = false;
    expect((await update({ action: "update", id: ID, status: "DONE" })).status).toBe(403);
    state.csrf = true;
    const notJson = new Request(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect((await adminUpdate(notJson)).status).toBe(415);
    expect(state.repository!.update).not.toHaveBeenCalled();
  });

  it("lists with an allowed status only, and changes the office's side as the signed-in Admin", async () => {
    expect((await adminList(new Request(`${url}?status=NEW`))).status).toBe(200);
    expect(state.repository!.list).toHaveBeenCalledWith({ status: "NEW" });
    expect((await adminList(new Request(`${url}?email=a%40example.com`))).status).toBe(400);
    const response = await update({ action: "update", id: ID, status: "IN_PROGRESS", assigneeLabel: "高橋", nextDueOn: "2026-11-20", staffNote: "電話の予定" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.repository!.update).toHaveBeenCalledWith("adm_00000000000000000000000000000001", ID, { status: "IN_PROGRESS", assigneeLabel: "高橋", nextDueOn: "2026-11-20", staffNote: "電話の予定" });
    expect((await update({ action: "delete", id: ID })).status).toBe(400);
    state.repository!.update!.mockRejectedValueOnce(new StoreValidationError("x"));
    expect((await update({ action: "update", id: ID, status: "WON" })).status).toBe(400);
  });
});
