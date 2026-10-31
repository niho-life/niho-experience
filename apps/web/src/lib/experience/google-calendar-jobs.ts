import "server-only";
import type { Pool } from "pg";
import { removeBookingEvent, writeConfirmedBooking } from "@niho-experience/google-calendar";
import { ExperienceStore, GoogleBookingCalendarEvents, type BookingCalendarWork } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { experiencePool } from "@/lib/experience/store-server";
import { verifyGoogleServiceIdentity, type GoogleServiceTokenVerifier } from "@/lib/google-service-identity";
import { googleAccessTokenForConnection, googleRuntimeConfig, syncOneDueProviderGoogle } from "./google-connection";
import { syncOneDueResourceGoogleAsScheduler } from "./resource-google";

/**
 * The Google calendar jobs (#238, docs/experience-runtime.md). Cloud Scheduler calls each every 5 minutes with its
 * service account's Google ID token:
 * - busy-sync reads the provider-wide input and each venue's or instructor's input whose 15 minutes are up (or whose
 *   watch said it changed). A read that fails closes the new bookings that need it until one succeeds, and tells the
 *   OWNER once (google-busy-failure.ts). The OTA worker's poll may read the same inputs; leases keep them apart.
 * - booking-events writes confirmed bookings to each provider's booking calendar and deletes cancelled ones.
 * Each step is bounded by count and by time. Counts only leave this module: never a calendar, a booking or a token.
 */
export const GOOGLE_CALENDAR_JOB_LIMITS = {
  providerReads: 20,
  resourceReads: 20,
  bookingEvents: 25,
  bookingLeaseMs: 120_000,
  /** Stop starting new reads or writes after this; Cloud Run and the scheduler allow far longer. */
  budgetMs: 45_000,
} as const;

type JobLimits = { readonly [Key in keyof typeof GOOGLE_CALENDAR_JOB_LIMITS]: number };

export interface GoogleBusySyncCounts {
  providerReads: number;
  providerFailed: number;
  resourceReads: number;
  resourceFailed: number;
}

export interface GoogleBusySyncDeps {
  syncProvider: () => Promise<{ applied: boolean } | null>;
  syncResource: () => Promise<{ processed: boolean; applied: boolean }>;
  now: () => number;
  limits?: Pick<JobLimits, "providerReads" | "resourceReads" | "budgetMs">;
}

export async function runGoogleBusySync(deps: GoogleBusySyncDeps): Promise<GoogleBusySyncCounts> {
  const limits = deps.limits ?? GOOGLE_CALENDAR_JOB_LIMITS;
  const deadline = deps.now() + limits.budgetMs;
  const counts: GoogleBusySyncCounts = { providerReads: 0, providerFailed: 0, resourceReads: 0, resourceFailed: 0 };
  while (counts.providerReads < limits.providerReads && deps.now() < deadline) {
    const read = await deps.syncProvider();
    if (!read) break;
    counts.providerReads += 1;
    if (!read.applied) counts.providerFailed += 1;
  }
  while (counts.resourceReads < limits.resourceReads && deps.now() < deadline) {
    const read = await deps.syncResource();
    if (!read.processed) break;
    counts.resourceReads += 1;
    if (!read.applied) counts.resourceFailed += 1;
  }
  return counts;
}

export interface GoogleBookingEventCounts {
  claimed: number;
  written: number;
  removed: number;
  failed: number;
}

export interface GoogleBookingEventDeps {
  events: Pick<GoogleBookingCalendarEvents, "claimDue" | "finish">;
  /** Null when the connection the work was claimed for is no longer the current one. */
  accessToken: (providerId: string, generation: number) => Promise<string | null>;
  write: (accessToken: string, work: BookingCalendarWork) => Promise<void>;
  remove: (accessToken: string, work: BookingCalendarWork) => Promise<void>;
  now: () => number;
  limits?: Pick<JobLimits, "bookingEvents" | "bookingLeaseMs" | "budgetMs">;
}

/**
 * One booking at a time, each claimed right before its requests so it has the whole lease. One token per provider and
 * run; a provider whose token cannot be had fails its bookings for this run (they are tried again later).
 */
export async function runGoogleBookingEvents(deps: GoogleBookingEventDeps): Promise<GoogleBookingEventCounts> {
  const limits = deps.limits ?? GOOGLE_CALENDAR_JOB_LIMITS;
  const deadline = deps.now() + limits.budgetMs;
  const counts: GoogleBookingEventCounts = { claimed: 0, written: 0, removed: 0, failed: 0 };
  const tokens = new Map<string, Promise<string | null>>();
  while (counts.claimed < limits.bookingEvents && deps.now() < deadline) {
    const [work] = await deps.events.claimDue(1, limits.bookingLeaseMs);
    if (!work) break;
    counts.claimed += 1;
    const key = `${work.providerId}\0${work.connectionGeneration}`;
    if (!tokens.has(key)) tokens.set(key, deps.accessToken(work.providerId, work.connectionGeneration));
    let outcome: "WRITTEN" | "REMOVED" | "FAILED";
    try {
      const token = await tokens.get(key)!;
      if (token === null) outcome = "FAILED";
      else if (work.action === "WRITE") { await deps.write(token, work); outcome = "WRITTEN"; }
      else { await deps.remove(token, work); outcome = "REMOVED"; }
    } catch {
      outcome = "FAILED";
    }
    await deps.events.finish(work, outcome);
    counts[outcome === "WRITTEN" ? "written" : outcome === "REMOVED" ? "removed" : "failed"] += 1;
  }
  return counts;
}

export interface GoogleCalendarJobSettings {
  readonly enabled: boolean;
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

export interface GoogleCalendarJobDependencies {
  readonly settings?: GoogleCalendarJobSettings;
  readonly verifier?: GoogleServiceTokenVerifier;
  readonly pool?: () => Pool | null;
  readonly busySync?: (pool: Pool) => Promise<GoogleBusySyncCounts>;
  readonly bookingEvents?: (pool: Pool) => Promise<GoogleBookingEventCounts>;
}

/** JSON for an internal route: never cached, sniffed or indexed. */
function internalServiceJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** 404 while the job is off, 401 for any other caller, 503 when Google's keys, the DB or the OAuth client are not there. */
async function jobResponse<T>(
  request: Pick<Request, "headers">,
  name: string,
  settings: GoogleCalendarJobSettings,
  dependencies: GoogleCalendarJobDependencies,
  run: (pool: Pool) => Promise<T>,
): Promise<Response> {
  if (!settings.enabled) return internalServiceJson({ error: "not_found" }, 404);
  const identity = await verifyGoogleServiceIdentity(request, settings, dependencies.verifier);
  if (!identity.ok) {
    return identity.kind === "outage"
      ? internalServiceJson({ error: "identity_verification_unavailable" }, 503)
      : internalServiceJson({ error: "invalid_identity" }, 401);
  }
  const pool = (dependencies.pool ?? experiencePool)();
  if (!pool || !googleRuntimeConfig()) return internalServiceJson({ error: "unavailable" }, 503);
  try {
    const counts = await run(pool);
    if (Object.values(counts as Record<string, number>).some((value) => value > 0)) console.info(`[google-calendar] ${name} ${JSON.stringify(counts)}`);
    return internalServiceJson(counts);
  } catch (error) {
    // The error's name only: a database message can quote row values.
    console.error(`[google-calendar] ${name} failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return internalServiceJson({ error: "unavailable" }, 503);
  }
}

const jobSettings = (enabled: boolean): GoogleCalendarJobSettings => ({
  enabled, audience: config.googleJobsAudience, serviceAccountEmail: config.googleJobsServiceAccountEmail,
});

/** POST /internal/google-calendar/v1/busy-sync. A read that failed is recorded on its input, not a failed run. */
export async function googleBusySyncResponse(request: Pick<Request, "headers">, dependencies: GoogleCalendarJobDependencies = {}): Promise<Response> {
  return jobResponse(request, "busy-sync", dependencies.settings ?? jobSettings(config.googleBusySyncEnabled), dependencies,
    dependencies.busySync ?? ((pool) => {
      const store = new ExperienceStore(pool);
      return runGoogleBusySync({
        syncProvider: () => syncOneDueProviderGoogle(pool, store),
        syncResource: () => syncOneDueResourceGoogleAsScheduler(pool),
        now: Date.now,
      });
    }));
}

/** POST /internal/google-calendar/v1/booking-events. */
export async function googleBookingEventsResponse(request: Pick<Request, "headers">, dependencies: GoogleCalendarJobDependencies = {}): Promise<Response> {
  return jobResponse(request, "booking-events", dependencies.settings ?? jobSettings(config.googleBookingEventsEnabled), dependencies,
    dependencies.bookingEvents ?? ((pool) => {
      const google = googleRuntimeConfig()!.google;
      return runGoogleBookingEvents({
        events: new GoogleBookingCalendarEvents(pool),
        accessToken: (providerId, generation) => googleAccessTokenForConnection(pool, providerId, generation),
        write: async (token, work) => {
          await writeConfirmedBooking(google, token, work.calendarId, { id: work.publicBookingId, title: work.title, startUtc: work.startUtc, endUtc: work.endUtc });
        },
        remove: (token, work) => removeBookingEvent(google, token, work.calendarId, work.publicBookingId),
        now: Date.now,
      });
    }));
}
