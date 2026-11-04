import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { config } from "@/lib/config";
import { doNotTrackEnabled } from "@/lib/analytics";

const EXPERIENCE_ORIGIN = "https://experience.niho.life";
const SETTINGS_PATH = "/api/public/experiences/site-settings";
const MEASUREMENT_ID = /^G-[A-Za-z0-9]{4,24}$/;
const VERIFICATION_CONTENT = /^[A-Za-z0-9_=-]{1,512}$/;

export type PublicSiteAnalyticsSettings = Readonly<{
  ga4MeasurementId: string | null;
  searchConsoleVerification: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** Fail closed if the public API grows or changes its deliberately small contract. */
function parsePublicSettings(value: unknown): PublicSiteAnalyticsSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, ["siteId", "siteOrigin", "analytics"])) return null;
  if (value.siteId !== "experience" || value.siteOrigin !== EXPERIENCE_ORIGIN || !isRecord(value.analytics)) return null;

  const analytics = value.analytics;
  if (!hasExactKeys(analytics, ["runtimeGate", "ga4", "searchConsoleVerificationMeta"]) || !isRecord(analytics.runtimeGate)) return null;

  const gate = analytics.runtimeGate;
  if (
    !hasExactKeys(gate, ["mode", "approvedOrigin", "previewCollection"]) ||
    gate.mode !== "production-origin-only" ||
    gate.approvedOrigin !== EXPERIENCE_ORIGIN ||
    gate.previewCollection !== false
  ) return null;

  let ga4MeasurementId: string | null = null;
  if (analytics.ga4 !== null) {
    if (!isRecord(analytics.ga4) || !hasExactKeys(analytics.ga4, ["measurementId"])) return null;
    if (typeof analytics.ga4.measurementId !== "string" || !MEASUREMENT_ID.test(analytics.ga4.measurementId)) return null;
    ga4MeasurementId = analytics.ga4.measurementId;
  }

  let searchConsoleVerification: string | null = null;
  if (analytics.searchConsoleVerificationMeta !== null) {
    const meta = analytics.searchConsoleVerificationMeta;
    if (!isRecord(meta) || !hasExactKeys(meta, ["name", "content"]) || meta.name !== "google-site-verification") return null;
    if (typeof meta.content !== "string" || !VERIFICATION_CONTENT.test(meta.content)) return null;
    searchConsoleVerification = meta.content;
  }

  return { ga4MeasurementId, searchConsoleVerification };
}

function requestHasApprovedOrigin(requestHeaders: Pick<Headers, "get">): boolean {
  return requestHeaders.get("host")?.trim().toLowerCase() === "experience.niho.life" &&
    requestHeaders.get("x-forwarded-proto")?.trim().toLowerCase() === "https";
}

/**
 * Request-scoped, uncached settings for the public Experience origin.
 * No setting is used on previews, noncanonical hosts, or when the API is down.
 */
export const getPublicSiteAnalyticsSettings = cache(async (): Promise<PublicSiteAnalyticsSettings | null> => {
  const requestHeaders = await headers();
  if (
    config.apiMode !== "http" ||
    config.siteUrl !== EXPERIENCE_ORIGIN ||
    !config.indexingAllowed ||
    !requestHasApprovedOrigin(requestHeaders)
  ) return null;

  try {
    const response = await fetch(new URL(SETTINGS_PATH, config.nihoWebOrigin), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;

    const parsed = parsePublicSettings(await response.json());
    if (!parsed) return null;
    return {
      ...parsed,
      // DNT is checked on the request and again in the browser before every send.
      ga4MeasurementId: doNotTrackEnabled(requestHeaders.get("dnt")) ? null : parsed.ga4MeasurementId,
    };
  } catch {
    return null;
  }
});
