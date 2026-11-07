#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { kamakuraAfter4Pm } from "../../apps/web/src/content/guides/kamakura-after-4-pm.ts";
import {
  importLegacyGuide,
  LegacyGuideImportError,
} from "../../packages/experience-store/src/legacy-guide-import.ts";
import {
  LegacyGuideImportEnvironmentError,
  resolveLegacyGuideImportEnvironment,
} from "./legacy-guide-import-environment.mjs";

const apply = process.argv.slice(2).includes("--apply");
const unknown = process.argv.slice(2).filter((argument) => argument !== "--apply");

export async function main(): Promise<number> {
  if (unknown.length > 0) {
    console.error("Usage: node scripts/gcp/import-kamakura-after-4-pm-guide.mts [--apply]");
    return 1;
  }
  const providerId = process.env.GUIDE_IMPORT_PROVIDER_ID?.trim() ?? "";
  const ownerId = process.env.GUIDE_IMPORT_OWNER_ID?.trim() ?? "";
  const categorySlug = process.env.GUIDE_IMPORT_CATEGORY_SLUG?.trim() ?? "";
  const missing = [
    ["GUIDE_IMPORT_PROVIDER_ID", providerId],
    ["GUIDE_IMPORT_OWNER_ID", ownerId],
    ["GUIDE_IMPORT_CATEGORY_SLUG", categorySlug],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    console.error(`Missing private input: ${missing.join(", ")}`);
    return 1;
  }

  let pool: Pool | undefined;
  try {
    const target = resolveLegacyGuideImportEnvironment(process.env, apply);
    pool = new Pool({ connectionString: target.connectionString, max: 1 });
    const identity = await pool.query<{ database: string; username: string; ledger: string | null }>(
      `SELECT current_database() AS database,current_user AS username,
              to_regclass('public.experience_schema_migrations')::text AS ledger`,
    );
    if (identity.rows[0]?.database !== target.database
      || identity.rows[0]?.username !== target.adminUser
      || identity.rows[0]?.ledger !== "experience_schema_migrations") {
      throw new LegacyGuideImportEnvironmentError("The Experience database identity or migration ledger is invalid.");
    }
    const migration = await pool.query(
      "SELECT 1 FROM experience_schema_migrations WHERE name=$1",
      ["0067_guide_provider_ownership.sql"],
    );
    if (migration.rows[0] === undefined) {
      throw new LegacyGuideImportEnvironmentError("Migration 0067_guide_provider_ownership.sql must be applied first.");
    }
    const result = await importLegacyGuide(pool, {
      providerId,
      ownerId,
      categorySlug,
      source: kamakuraAfter4Pm,
      dryRun: !apply,
    });
    console.log(JSON.stringify({
      mode: result.dryRun ? "dry-run" : "apply",
      outcome: result.outcome,
      linkedPublishedExperienceCount: result.linkedPublishedExperienceCount,
    }));
    return 0;
  } catch (error) {
    console.error(error instanceof LegacyGuideImportError || error instanceof LegacyGuideImportEnvironmentError
      ? error.message
      : "The legacy guide import failed.");
    return 1;
  } finally {
    await pool?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
