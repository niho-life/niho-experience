import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationConnection } from "./experience-migration-connection.mjs";

const environments = {
  stg: { project: "niho-app-stg", adminUser: "niho", adminDatabase: "niho", secret: "experience-stg-database-url" },
  prd: { project: "niho-app-prd", adminUser: "niho_app", adminDatabase: "niho_app", secret: "experience-prd-database-url" },
};
const stg = { NIHO_DB_ENV: "stg", CONFIRM_EXPERIENCE_DB_MIGRATE: "niho-app-stg" };
const host = "ep-fixture.c-2.ap-southeast-1.aws.neon.tech";
const neon = {
  ...stg,
  EXPERIENCE_DB_PROVIDER: "neon",
  EXPERIENCE_NEON_STG_HOST: host,
  DATABASE_URL: `postgresql://niho_stg_migrator:synthetic@${host}/neondb?sslmode=require`,
};

test("existing Cloud SQL staging continues to use the IAP tunnel and original Secret", () => {
  const result = migrationConnection({ ...stg, DATABASE_URL: "postgresql://niho:fixture@127.0.0.1:3001/niho" }, environments);
  assert.equal(result.neon, false);
  assert.equal(result.env.secret, "experience-stg-database-url");
});

test("Neon staging uses a different runtime Secret and enables full TLS verification", () => {
  const result = migrationConnection(neon, environments);
  assert.equal(result.neon, true);
  assert.equal(result.env.secret, "experience-stg-neon-database-url");
  assert.equal(result.localUrl.searchParams.get("sslmode"), "verify-full");
});

test("Neon mode rejects production and connections outside its approved direct endpoint", () => {
  for (const override of [
    { NIHO_DB_ENV: "prd", CONFIRM_EXPERIENCE_DB_MIGRATE: "niho-app-prd" },
    { EXPERIENCE_NEON_STG_HOST: "ep-other.ap-southeast-1.aws.neon.tech" },
    { DATABASE_URL: neon.DATABASE_URL.replace("ep-fixture", "ep-fixture-pooler"), EXPERIENCE_NEON_STG_HOST: host.replace("ep-fixture", "ep-fixture-pooler") },
    { DATABASE_URL: neon.DATABASE_URL.replace("/neondb", "/experience_prd") },
    { DATABASE_URL: neon.DATABASE_URL + "&host=127.0.0.1" },
  ]) {
    assert.throws(() => migrationConnection({ ...neon, ...override }, environments));
  }
});
