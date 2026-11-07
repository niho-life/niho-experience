// Safe environment-to-database mapping for the one-time legacy Guide import.
// It accepts only the localhost IAP connection prepared by niho-app's niho-db.sh
// and never includes the URL or credentials in an error message.

const ENVIRONMENTS = Object.freeze({
  stg: Object.freeze({
    project: "niho-app-stg",
    adminDatabase: "niho",
    adminUser: "niho",
    database: "experience_stg",
  }),
  prd: Object.freeze({
    project: "niho-app-prd",
    adminDatabase: "niho_app",
    adminUser: "niho_app",
    database: "experience_prd",
  }),
});

export class LegacyGuideImportEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegacyGuideImportEnvironmentError";
  }
}

function assert(condition, message) {
  if (!condition) throw new LegacyGuideImportEnvironmentError(message);
}

export function resolveLegacyGuideImportEnvironment(environment, apply) {
  const envName = environment.NIHO_DB_ENV;
  const target = ENVIRONMENTS[envName];
  assert(target, "NIHO_DB_ENV must be stg or prd (run through niho-db.sh).");

  let localUrl;
  try {
    localUrl = new URL(environment.DATABASE_URL ?? "");
  } catch {
    throw new LegacyGuideImportEnvironmentError("DATABASE_URL must be a valid PostgreSQL URL from niho-db.sh.");
  }
  assert(localUrl.protocol === "postgresql:" || localUrl.protocol === "postgres:",
    "DATABASE_URL must be a PostgreSQL URL from niho-db.sh.");
  assert(localUrl.hostname === "127.0.0.1" && localUrl.port !== "",
    "The official IAP bastion localhost tunnel is required.");
  assert(localUrl.pathname === `/${target.adminDatabase}`
    && decodeURIComponent(localUrl.username) === target.adminUser,
    "The NIHO management database and administrator identity do not match NIHO_DB_ENV.");
  assert(localUrl.password !== "", "The NIHO administrator credential is missing.");
  if (apply) {
    assert(environment.CONFIRM_EXPERIENCE_GUIDE_IMPORT === target.project,
      `CONFIRM_EXPERIENCE_GUIDE_IMPORT=${target.project} is required for --apply.`);
  }

  const experienceUrl = new URL(localUrl);
  experienceUrl.pathname = `/${target.database}`;
  return Object.freeze({
    project: target.project,
    database: target.database,
    adminUser: target.adminUser,
    connectionString: experienceUrl.toString(),
  });
}
