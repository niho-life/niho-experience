import "server-only";
import { resolveConfig } from "./resolve-config";

/** Server-side settings, read when the server starts. Safe defaults let a fresh clone run with no .env. */
export const config = resolveConfig(process.env);

export const isPreview = config.apiMode === "mock";

/** The shared staging site can be parked while its database is stopped. */
export const isExperienceStaging = config.apiMode === "http" && new URL(config.siteUrl).origin === "https://experience-stg.niho.life";

/** Pilot fixtures and their static editorial/sample assets are only for the mock preview. */
export const isPilotPreview = isPreview && config.mockCatalog === "pilot";
