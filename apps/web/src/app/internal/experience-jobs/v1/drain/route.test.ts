import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuestBookingRepository, GuestMailOutbox, GuestQuestionRepository, GuestQuestionTranslations } from "@niho-experience/experience-store";

/** The experience mail job's trigger (#285 slice 5) with a synthetic Google identity, pool, mailer and run. */
const mocks = vi.hoisted(() => ({
  config: {
    guestMailEnabled: true,
    experienceJobsAudience: "https://experience.example/internal/experience-jobs",
    experienceJobsServiceAccountEmail: "experience-jobs@example.iam.gserviceaccount.com",
    siteUrl: "https://experience.example",
  },
  verifyIdToken: vi.fn(),
  pool: vi.fn(),
  mailer: vi.fn(),
  run: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: mocks.pool }));
vi.mock("@/lib/mail/transport", () => ({ smtpMailer: mocks.mailer }));
vi.mock("@/lib/experience-jobs/drain", async (original) => ({ ...await original<typeof import("@/lib/experience-jobs/drain")>(), runExperienceJobs: mocks.run }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));

import type { GoogleServiceTokenVerifier } from "@/lib/google-service-identity";
import { experienceJobsDrainResponse } from "@/lib/experience-jobs/job";
import * as route from "./route";

const URL = "https://experience.example/internal/experience-jobs/v1/drain";
const counts = {
  questionReplies: { claimed: 2, sent: 1, retried: 1, failed: 0 },
  bookingConfirmations: { claimed: 1, sent: 1, skipped: 0, retried: 0, failed: 0, abandoned: 0 },
  guestTranslations: { claimed: 1, translated: 1, retried: 0, failed: 0, closed: 0, abandoned: 0 },
  guestErasure: { erased: 0 },
  questionErasure: { erased: 0 },
};
const idle = {
  questionReplies: { claimed: 0, sent: 0, retried: 0, failed: 0 },
  bookingConfirmations: { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 },
  guestTranslations: { off: true },
  guestErasure: { erased: 0 },
  questionErasure: { erased: 0 },
};
const fakePool = { query: vi.fn(), connect: vi.fn() };
const fakeMailer = { sendMail: vi.fn(), close: vi.fn() };
const post = (headers: Record<string, string> = { authorization: "Bearer synthetic.jwt.token" }) => route.POST(new Request(URL, { method: "POST", headers }));
const payload = (overrides: Record<string, unknown> = {}) => ({
  getPayload: () => ({
    iss: "https://accounts.google.com",
    aud: mocks.config.experienceJobsAudience,
    email: mocks.config.experienceJobsServiceAccountEmail,
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    sub: "service-synthetic",
    ...overrides,
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.guestMailEnabled = true;
  mocks.verifyIdToken.mockResolvedValue(payload());
  mocks.pool.mockReturnValue(fakePool);
  mocks.mailer.mockReturnValue(fakeMailer);
  mocks.run.mockResolvedValue(counts);
});

describe("POST /internal/experience-jobs/v1/drain", () => {
  it("exports POST only, so every other method gets 405", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("is 404 before identity, database or mail while guest mail is off", async () => {
    mocks.config.guestMailEnabled = false;
    const response = await post();
    expect(response.status).toBe(404);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.mailer).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("accepts only the scheduler's Google service identity", async () => {
    for (const headers of [{}, { authorization: "Basic synthetic" }, { cookie: "__Secure-niho_host_session=synthetic" }] as Record<string, string>[]) {
      expect((await post(headers)).status).toBe(401);
    }
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    for (const claims of [
      { email: "host-push-job@example.iam.gserviceaccount.com" },
      { aud: "https://experience.example/internal/host-push" },
      { email_verified: false },
      { iss: "https://securetoken.google.com/project" },
      { exp: Math.floor(Date.now() / 1000) - 1 },
    ]) {
      mocks.verifyIdToken.mockResolvedValueOnce(payload(claims));
      const response = await post();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid_identity" });
    }
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic.jwt.token", audience: mocks.config.experienceJobsAudience });
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.mailer).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("is 503 when Google's keys, the experience DB or the SMTP credentials are not there", async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } }));
    const outage = await post();
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ error: "identity_verification_unavailable" });
    mocks.pool.mockReturnValueOnce(null);
    expect((await post()).status).toBe(503);
    mocks.mailer.mockReturnValueOnce(null);
    const noMailer = await post();
    expect(noMailer.status).toBe(503);
    expect(await noMailer.json()).toEqual({ error: "unavailable" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("runs once on the experience DB with the SMTP mailer, answers its counts uncached, and closes the mailer", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.json()).toEqual(counts);
    expect(mocks.run).toHaveBeenCalledOnce();
    const deps = mocks.run.mock.calls[0]![0];
    expect(deps.questions).toBeInstanceOf(GuestQuestionRepository);
    expect(deps.confirmations).toBeInstanceOf(GuestMailOutbox);
    expect(deps.guests).toBeInstanceOf(GuestBookingRepository);
    expect(deps.translations).toBeInstanceOf(GuestQuestionTranslations);
    // Translation is off in this configuration: no Claude API.
    expect(deps.translator).toBeNull();
    expect(deps.mailer).toBe(fakeMailer);
    expect(deps.siteUrl).toBe("https://experience.example");
    expect(deps.now()).toBeInstanceOf(Date);
    expect(fakeMailer.close).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledExactlyOnceWith(`[experience-jobs] drain ${JSON.stringify(counts)}`);
    info.mockRestore();
  });

  it("logs nothing for a run that found nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.run.mockResolvedValueOnce(idle);
    expect((await post()).status).toBe(200);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("answers 503 with the counts when a step failed, and logs one line with the error class only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.run.mockImplementationOnce(async (deps) => {
      deps.onStepError("bookingConfirmations", "TypeError");
      return { ...counts, bookingConfirmations: { error: "unavailable" } };
    });
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ...counts, bookingConfirmations: { error: "unavailable" } });
    expect(error).toHaveBeenCalledExactlyOnceWith(`[experience-jobs] drain ${JSON.stringify({ ...counts, bookingConfirmations: { error: "unavailable" }, errors: { bookingConfirmations: "TypeError" } })}`);
    expect(fakeMailer.close).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("is 503 when the run itself throws, logs no message, and still closes the mailer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.run.mockRejectedValueOnce(new Error("guest@example.com synthetic"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/example\.com|synthetic/);
    expect(fakeMailer.close).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

describe("experienceJobsDrainResponse dependencies", () => {
  const settings = { enabled: true, audience: "https://experience.example/internal/experience-jobs", serviceAccountEmail: "experience-jobs@example.iam.gserviceaccount.com" };
  const claims = { iss: "accounts.google.com", aud: settings.audience, email: settings.serviceAccountEmail, emailVerified: true, exp: Math.floor(Date.now() / 1000) + 60 };
  const verifier = (result: Awaited<ReturnType<GoogleServiceTokenVerifier["verify"]>>): GoogleServiceTokenVerifier => ({ verify: vi.fn().mockResolvedValue(result) });
  const request = new Request(URL, { method: "POST", headers: { authorization: "Bearer synthetic.jwt.token" } });

  it("separates an invalid identity from a verification outage", async () => {
    const run = vi.fn(async () => counts);
    expect((await experienceJobsDrainResponse(request, { settings, verifier: verifier({ ok: false, kind: "invalid" }), run })).status).toBe(401);
    expect((await experienceJobsDrainResponse(request, { settings, verifier: verifier({ ok: false, kind: "outage" }), run })).status).toBe(503);
    expect((await experienceJobsDrainResponse(request, { settings: { ...settings, enabled: false }, verifier: verifier({ ok: true, claims }), run })).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs every step against an unreachable database and reports each as failed, without its message", async () => {
    const { runExperienceJobs: realRun } = await vi.importActual<typeof import("@/lib/experience-jobs/drain")>("@/lib/experience-jobs/drain");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432 (guest@example.com)"), { code: "ECONNREFUSED" });
    const pool = { query: vi.fn().mockRejectedValue(down), connect: vi.fn().mockRejectedValue(down) };
    const mailer = { sendMail: vi.fn(), close: vi.fn() };
    const translator = vi.fn();
    const response = await experienceJobsDrainResponse(request, {
      settings, verifier: verifier({ ok: true, claims }), pool: () => pool as never, mailer: () => mailer, translator: () => translator, run: realRun,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      questionReplies: { error: "unavailable" },
      bookingConfirmations: { error: "unavailable" },
      guestTranslations: { error: "unavailable" },
      guestErasure: { error: "unavailable" },
      questionErasure: { error: "unavailable" },
    });
    expect(pool.connect).toHaveBeenCalledTimes(3);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(translator).not.toHaveBeenCalled();
    expect(mailer.close).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/example\.com|10\.0\.0\.1|ECONNREFUSED/);
    error.mockRestore();
  });
});
