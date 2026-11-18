import assert from "node:assert/strict";

export function migrationConnection(settings, environments) {
  const envName = settings.NIHO_DB_ENV;
  assert(envName === "stg" || envName === "prd", "NIHO_DB_ENV must be stg or prd");
  const provider = settings.EXPERIENCE_DB_PROVIDER || "cloudsql";
  assert(provider === "cloudsql" || (provider === "neon" && envName === "stg"),
    "Neon migrations are staging only");
  const base = environments[envName];
  assert(base, "NIHO_DB_ENV must be stg or prd");
  assert(settings.CONFIRM_EXPERIENCE_DB_MIGRATE === base.project,
    `CONFIRM_EXPERIENCE_DB_MIGRATE=${base.project} is required`);

  let localUrl;
  try {
    localUrl = new URL(settings.DATABASE_URL);
  } catch {
    throw new Error("A valid PostgreSQL URL is required");
  }
  assert(localUrl.protocol === "postgresql:" || localUrl.protocol === "postgres:", "PostgreSQL URL required");
  const neon = provider === "neon";
  const env = neon ? {
    ...base,
    adminDatabase: "neondb",
    adminUser: "niho_stg_migrator",
    secret: "experience-stg-neon-database-url",
  } : base;
  if (neon) {
    assert(/^ep-[a-z0-9-]+(?:\.c-[0-9]+)?\.[a-z0-9-]+\.aws\.neon\.tech$/.test(localUrl.hostname)
      && !localUrl.hostname.includes("-pooler.")
      && localUrl.hostname === settings.EXPERIENCE_NEON_STG_HOST && !localUrl.searchParams.has("host")
      && (!localUrl.port || localUrl.port === "5432"),
      "The approved staging Neon direct endpoint is required");
    localUrl.search = "?sslmode=verify-full";
  } else {
    assert(localUrl.hostname === "127.0.0.1" && localUrl.port, "IAP bastion localhost tunnel required");
  }
  assert(localUrl.pathname === `/${env.adminDatabase}` && decodeURIComponent(localUrl.username) === env.adminUser,
    "NIHO administrator connection required");
  assert(localUrl.password, "Administrator password is missing");
  return { env, localUrl, neon };
}
