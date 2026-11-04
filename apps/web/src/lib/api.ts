import "server-only";
import { createExperienceApiClient, type ExperienceCatalogResponseV11, type ExperienceDetailResponseV11, type RegionKey, type ReadResult } from "@niho-experience/api-client";
import { config } from "./config";
import { normalizeExperienceDate, normalizeExperienceTheme } from "./filters";

/** SSR reads only public catalog and detail data. Guest input never reaches this module. */
export async function getApi(searchParams?: Record<string, string | string[] | undefined>) {
  if (config.apiMode === "mock") {
    const { createMockExperienceFetch } = await import("@niho-experience/api-client/mock");
    const requested = typeof searchParams?.mock === "string" ? searchParams.mock : "";
    const scenarios = { empty: "empty-catalog", error: "network-error", slow: "slow", soldout: "sold-out", "gallery-single-photo": "gallery-single-photo", "gallery-no-photos": "gallery-no-photos" } as const;
    const scenario = scenarios[requested as keyof typeof scenarios] ?? (config.mockLatencyMs > 0 ? "slow" : "default");
    return createExperienceApiClient({
      nihoWebOrigin: config.nihoWebOrigin,
      fetch: createMockExperienceFetch({ scenario, catalog: config.mockCatalog, slowDelayMs: requested === "slow" ? 1500 : config.mockLatencyMs }),
    });
  }
  return createExperienceApiClient({
    nihoWebOrigin: config.nihoWebOrigin,
    cacheableReadInit: { next: { revalidate: 60 } } as RequestInit,
  });
}

/** Read the catalog version selected for this runtime; v1.2 stays opt-in until NIHO deploys it. */
export async function listExperiencesForSite(region?: RegionKey, searchParams?: Record<string, string | string[] | undefined>) {
  if (config.experiencePublicationsEnabled) {
    try {
      const { listPublicationSummaries } = await import("./experience/publication-site");
      return { ok: true, data: { experiences: await listPublicationSummaries(region) } } satisfies ReadResult<ExperienceCatalogResponseV11>;
    } catch {
      return { ok: false, kind: "network_error" } as const;
    }
  }
  const client = await getApi(searchParams);
  if (config.publicApiVersion === "1.2") {
    const theme = normalizeExperienceTheme(searchParams?.theme);
    const availableOn = normalizeExperienceDate(searchParams?.date);
    return client.listExperiencesV12({ ...(region ? { region } : {}), ...(theme ? { theme } : {}), ...(availableOn ? { availableOn } : {}) });
  }
  return config.publicApiVersion === "1.1"
    ? client.listExperiencesV11(region ? { region } : {})
    : client.listExperiences(region ? { region } : {});
}

/** Read the detail version selected for this runtime; older deployments keep using the v1.0 path. */
export async function getExperienceForSite(slug: string, searchParams?: Record<string, string | string[] | undefined>, locale: "en" | "ja" = "en") {
  if (config.experiencePublicationsEnabled) {
    try {
      const { getPublicationDetail } = await import("./experience/publication-site");
      const experience = await getPublicationDetail(slug, locale);
      return experience ? { ok: true, data: { experience } } satisfies ReadResult<ExperienceDetailResponseV11> : { ok: false, kind: "not_found" } as const;
    } catch {
      return { ok: false, kind: "network_error" } as const;
    }
  }
  const client = await getApi(searchParams);
  return config.publicApiVersion === "1.1" || config.publicApiVersion === "1.2" ? client.getExperienceV11(slug) : client.getExperience(slug);
}
