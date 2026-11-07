import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kamakuraAfter4Pm } from "../../../apps/web/src/content/guides/kamakura-after-4-pm.ts";
import { legacyGuideContent } from "../src/legacy-guide-import.ts";

const environmentModule = await import(
  new URL("../../../scripts/gcp/legacy-guide-import-environment.mjs", import.meta.url).href
) as {
  resolveLegacyGuideImportEnvironment: (
    environment: Record<string, string | undefined>,
    apply: boolean,
  ) => { project: string; database: string; adminUser: string; connectionString: string };
};

describe("legacy Guide import content", () => {
  it("preserves the static source and renders its FAQ in the database Markdown", () => {
    const content = legacyGuideContent(kamakuraAfter4Pm);
    assert.equal(content.language, "en");
    assert.deepEqual(content.author, kamakuraAfter4Pm.author);
    assert.equal(content.checkedOn, kamakuraAfter4Pm.checkedAt);
    assert.ok(content.markdown.startsWith(kamakuraAfter4Pm.body));
    assert.match(content.markdown, /## Frequently asked questions/);
    for (const item of kamakuraAfter4Pm.faq ?? []) {
      assert.match(content.markdown, new RegExp(`### ${item.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.ok(content.markdown.includes(item.answer));
    }
  });
});

describe("legacy Guide import wrapper environment", () => {
  it("accepts only the official environment mapping and requires apply confirmation", () => {
    const staging = {
      NIHO_DB_ENV: "stg",
      DATABASE_URL: "postgresql://niho:synthetic-password@127.0.0.1:15432/niho",
    };
    const dryRun = environmentModule.resolveLegacyGuideImportEnvironment(staging, false);
    const dryRunUrl = new URL(dryRun.connectionString);
    assert.equal(dryRun.project, "niho-app-stg");
    assert.equal(dryRun.database, "experience_stg");
    assert.equal(dryRun.adminUser, "niho");
    assert.equal(dryRunUrl.hostname, "127.0.0.1");
    assert.equal(dryRunUrl.pathname, "/experience_stg");
    assert.throws(
      () => environmentModule.resolveLegacyGuideImportEnvironment(staging, true),
      /CONFIRM_EXPERIENCE_GUIDE_IMPORT=niho-app-stg is required/,
    );
    assert.equal(environmentModule.resolveLegacyGuideImportEnvironment({
      ...staging,
      CONFIRM_EXPERIENCE_GUIDE_IMPORT: "niho-app-stg",
    }, true).project, "niho-app-stg");

    const production = environmentModule.resolveLegacyGuideImportEnvironment({
      NIHO_DB_ENV: "prd",
      DATABASE_URL: "postgresql://niho_app:synthetic-password@127.0.0.1:15432/niho_app",
      CONFIRM_EXPERIENCE_GUIDE_IMPORT: "niho-app-prd",
    }, true);
    assert.equal(production.database, "experience_prd");
    assert.equal(new URL(production.connectionString).pathname, "/experience_prd");

    assert.throws(
      () => environmentModule.resolveLegacyGuideImportEnvironment({
        NIHO_DB_ENV: "prd",
        DATABASE_URL: "postgresql://niho_app:synthetic-password@localhost:15432/niho_app",
        CONFIRM_EXPERIENCE_GUIDE_IMPORT: "niho-app-prd",
      }, true),
      /official IAP bastion localhost tunnel/,
    );
    assert.throws(
      () => environmentModule.resolveLegacyGuideImportEnvironment({
        NIHO_DB_ENV: "prd",
        DATABASE_URL: "postgresql://wrong-user:synthetic-password@127.0.0.1:15432/niho_app",
        CONFIRM_EXPERIENCE_GUIDE_IMPORT: "niho-app-prd",
      }, true),
      /management database and administrator identity/,
    );
  });
});
