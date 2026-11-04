import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreNotFoundError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, apiMode: "http" as "http" | "mock", experienceTranslateApiEnabled: false, guestBookingEnabled: true, nihoWebOrigin: "https://niho.example" },
  readHost: vi.fn(),
  usable: vi.fn(),
  create: vi.fn(),
  clear: vi.fn(),
  upstreamFetch: vi.fn(),
  owner: vi.fn(),
  hostMock: false,
  providers: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("./session", () => ({ accessTokenUsable: mocks.usable }));
vi.mock("./server", () => ({
  readHostSession: mocks.readHost,
  nihoApiFetch: () => mocks.upstreamFetch,
  siteOrigin: () => "https://experience.example",
  clearSessionCookie: mocks.clear,
  isHostMock: () => mocks.hostMock,
  loadHostProviders: mocks.providers,
}));
vi.mock("@/host/site-bookings-server", () => ({ asOwner: mocks.owner }));
vi.mock("@niho-experience/api-client/experience-translate-rooms", () => ({ createExperienceTranslateRoomsClient: mocks.create }));

import { loadSiteTranslateRoomsClient, loadTranslateRoomsClient, readEmptyTranslateBody, siteTranslateBookingEligible, translateRoomsEnabled, translateRoomsEntry, translateRoomsFailure, translateRoomsMutationAllowed } from "./translate-rooms-server";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("https://experience.example/host/api/translate/x", { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", ...headers }, body });

describe("translate rooms server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, { hostConsoleEnabled: true, apiMode: "http", experienceTranslateApiEnabled: false, guestBookingEnabled: true });
    mocks.usable.mockReturnValue(true);
    mocks.create.mockReturnValue({ marker: "translate-client" });
    mocks.hostMock = false;
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider_1", memberRole: "OWNER" }] });
  });

  it("is open in mock mode, and in http only behind its own flag with the host console", () => {
    expect(translateRoomsEnabled()).toBe(false);
    mocks.config.experienceTranslateApiEnabled = true;
    mocks.config.guestBookingEnabled = false;
    expect(translateRoomsEnabled()).toBe(true);
    mocks.config.hostConsoleEnabled = false;
    expect(translateRoomsEnabled()).toBe(false);
    Object.assign(mocks.config, { hostConsoleEnabled: true, apiMode: "mock", experienceTranslateApiEnabled: false });
    expect(translateRoomsEnabled()).toBe(true);
    expect(translateRoomsEntry()).toEqual({ today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    mocks.config.hostConsoleEnabled = false;
    expect(translateRoomsEntry()).toBeNull();
  });

  it("uses only the sealed current host session and NIHO's fetch for that session", async () => {
    mocks.config.experienceTranslateApiEnabled = true;
    mocks.config.guestBookingEnabled = false;
    mocks.readHost.mockResolvedValue({ accessToken: "sealed-host-token" });
    const loaded = await loadTranslateRoomsClient();
    expect(loaded).toEqual({ ok: true, client: { marker: "translate-client" } });
    expect(mocks.create).toHaveBeenCalledWith({ nihoWebOrigin: "https://niho.example", accessToken: "sealed-host-token", fetch: mocks.upstreamFetch });
  });

  it("answers 404 while closed, 401 without a session and 401 refresh when the token is nearly out", async () => {
    expect((await loadTranslateRoomsClient()).ok).toBe(false);
    expect((await loadTranslateRoomsClient() as { response: Response }).response.status).toBe(404);
    mocks.config.experienceTranslateApiEnabled = true;
    mocks.readHost.mockResolvedValue(null);
    expect((await loadTranslateRoomsClient() as { response: Response }).response.status).toBe(401);
    mocks.readHost.mockResolvedValue({ accessToken: "sealed-host-token" });
    mocks.usable.mockReturnValue(false);
    const refresh = (await loadTranslateRoomsClient() as { response: Response }).response;
    expect(refresh.status).toBe(401);
    expect(await refresh.json()).toEqual({ error: "session_refresh_required" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps NIHO's refusals without their bodies, clears the cookie on 401 and keeps 404 as not_found", async () => {
    const ended = translateRoomsFailure({ ok: false, kind: "rejected", status: 401 });
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: "session_ended" });
    expect(mocks.clear).toHaveBeenCalledWith(ended);
    expect(await translateRoomsFailure({ ok: false, kind: "rejected", status: 403 }).json()).toEqual({ error: "permission_ended" });
    const missing = translateRoomsFailure({ ok: false, kind: "not_found" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(translateRoomsFailure({ ok: false, kind: "conflict" }).status).toBe(409);
    expect(translateRoomsFailure({ ok: false, kind: "limited" }).status).toBe(429);
    expect(translateRoomsFailure({ ok: false, kind: "invalid_request" }).status).toBe(400);
    expect(translateRoomsFailure({ ok: false, kind: "network_error" }).status).toBe(502);
    expect(translateRoomsFailure({ ok: false, kind: "unexpected_response", status: 500 }).status).toBe(502);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(missing.headers.get("referrer-policy")).toBe("no-referrer");
    expect(missing.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("requires a same-origin mutation and an empty body", async () => {
    expect(translateRoomsMutationAllowed(post(null))).toBe(true);
    expect(translateRoomsMutationAllowed(post(null, { origin: "https://evil.example" }))).toBe(false);
    expect(translateRoomsMutationAllowed(new Request("https://experience.example/host/api/translate/x"))).toBe(true);
    expect(await readEmptyTranslateBody(post(null))).toBe(true);
    expect(await readEmptyTranslateBody(post("{}", { "content-type": "application/json" }))).toBe(true);
    expect(await readEmptyTranslateBody(post(JSON.stringify({ language: "fr" }), { "content-type": "application/json" }))).toBe(false);
    expect(await readEmptyTranslateBody(post("[]", { "content-type": "application/json" }))).toBe(false);
    expect(await readEmptyTranslateBody(post("not json", { "content-type": "application/json" }))).toBe(false);
    expect(await readEmptyTranslateBody(post("x".repeat(2048), { "content-type": "application/json" }))).toBe(false);
  });

  it("site createは確定・未取消・英語・当日以降だけを許可する", () => {
    const booking = { status: "CONFIRMED" as const, cancelledAtUtc: null, language: "EN" as const, localDate: "2026-11-03" };
    expect(siteTranslateBookingEligible(booking, "2026-11-03")).toBe(true);
    expect(siteTranslateBookingEligible({ ...booking, status: "PAYMENT_REVIEW" }, "2026-11-03")).toBe(false);
    expect(siteTranslateBookingEligible({ ...booking, status: "CANCELLED", cancelledAtUtc: "2026-11-01T00:00:00.000Z" }, "2026-11-03")).toBe(false);
    expect(siteTranslateBookingEligible({ ...booking, language: "JA" }, "2026-11-03")).toBe(false);
    expect(siteTranslateBookingEligible({ ...booking, localDate: "2026-11-02" }, "2026-11-03")).toBe(false);
  });

  it("site BFFはNIHO OWNERとExperience storeの所属を毎回照合し、createだけ状態を制限する", async () => {
    mocks.config.experienceTranslateApiEnabled = true;
    mocks.readHost.mockResolvedValue({ accessToken: "sealed-host-token" });
    const booking = { status: "CONFIRMED", cancelledAtUtc: null, language: "EN", localDate: "2099-01-01" };
    const getGuestBookingForHost = vi.fn().mockResolvedValue(booking);
    mocks.owner.mockResolvedValue({ ok: true, bookings: { getGuestBookingForHost }, actor: { providerId: "provider_1", nihoUserId: "owner_1", calendarRoleCeiling: "OWNER" } });
    expect((await loadSiteTranslateRoomsClient("provider_1", "booking_1", "create")).ok).toBe(true);
    expect(getGuestBookingForHost).toHaveBeenCalledWith(expect.objectContaining({ providerId: "provider_1" }), "booking_1");

    getGuestBookingForHost.mockResolvedValue({ ...booking, status: "CANCELLED", cancelledAtUtc: "2026-11-01T00:00:00.000Z" });
    const rejected = await loadSiteTranslateRoomsClient("provider_1", "booking_1", "create");
    expect(rejected.ok).toBe(false);
    expect((rejected as { response: Response }).response.status).toBe(409);
    // 自分の予約であれば、取消後もstatus/endのNIHO照合へ進める。
    expect((await loadSiteTranslateRoomsClient("provider_1", "booking_1", "status")).ok).toBe(true);
    expect((await loadSiteTranslateRoomsClient("provider_1", "booking_1", "end")).ok).toBe(true);

    getGuestBookingForHost.mockRejectedValueOnce(new StoreNotFoundError("Guest booking"));
    const otherBooking = await loadSiteTranslateRoomsClient("provider_1", "booking_other", "status");
    expect(otherBooking.ok).toBe(false);
    expect((otherBooking as { response: Response }).response.status).toBe(404);

    mocks.owner.mockResolvedValue({ ok: false, message: "other provider" });
    const other = await loadSiteTranslateRoomsClient("provider_2", "booking_1", "status");
    expect(other.ok).toBe(false);
    expect((other as { response: Response }).response.status).toBe(404);
  });

  it("閉じているsite bookingのroom APIは販売を開かず404にする", async () => {
    mocks.config.experienceTranslateApiEnabled = true;
    mocks.config.guestBookingEnabled = false;
    const result = await loadSiteTranslateRoomsClient("provider_1", "booking_1", "create");
    expect(result.ok).toBe(false);
    expect((result as { response: Response }).response.status).toBe(404);
    expect(mocks.readHost).not.toHaveBeenCalled();
    expect(mocks.owner).not.toHaveBeenCalled();
  });

  it("mock site-bookingsは合成予約の所属と条件だけでsite clientへ進む", async () => {
    Object.assign(mocks.config, { apiMode: "mock", experienceTranslateApiEnabled: false });
    mocks.hostMock = true;
    mocks.readHost.mockResolvedValue({ accessToken: "mock-host-token", mockScenario: "site-bookings" });
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "sample-provider-kitchen", memberRole: "OWNER" }] });
    expect((await loadSiteTranslateRoomsClient("sample-provider-kitchen", "00000000-0000-4000-8000-00000000b101", "create")).ok).toBe(true);
    const missing = await loadSiteTranslateRoomsClient("sample-provider-kitchen", "00000000-0000-4000-8000-00000000ffff", "create");
    expect(missing.ok).toBe(false);
    expect((missing as { response: Response }).response.status).toBe(404);
  });
});
