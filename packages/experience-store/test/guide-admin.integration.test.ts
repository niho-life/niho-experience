import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { GuideAdminRepository } from "../src/guide-admin.ts";
import { GuideRepository } from "../src/guides.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const baseMigrations = [
  "0001_experience_store.sql",
  "0002_google_oauth.sql",
  "0003_google_busy_coverage.sql",
  "0004_host_push_subscriptions.sql",
  "0005_guide_cms.sql",
] as const;

const command = (suffix: string) => ({
  idempotencyKey: `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
  actorNihoUserId: "admin-synthetic",
});

describe("PostgreSQL guide administration", { skip: databaseUrl === undefined }, () => {
  it("serializes versions and revisions while preserving immutable idempotency receipts", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_guide_admin_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const name of baseMigrations) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query(
        `INSERT INTO guide_writer_grants (niho_user_id, granted_by_niho_user_id)
         VALUES ('writer-legacy','admin-legacy')`,
      );
      await pool.query(
        `INSERT INTO guide_categories (slug, label_en, label_ja, display_order, active)
         VALUES ('legacy','Legacy','旧',20,false)`,
      );
      await pool.query(await readFile(new URL("../migrations/0012_guide_admin.sql", import.meta.url), "utf8"));

      const admin = new GuideAdminRepository(pool);
      assert.deepEqual(await admin.getWriterGrant("writer-missing"), {
        nihoUserId: "writer-missing",
        active: false,
        sourceVersion: 0,
      });
      assert.deepEqual(await admin.getWriterGrant("writer-legacy"), {
        nihoUserId: "writer-legacy",
        active: true,
        sourceVersion: 0,
      });

      const invitationV2 = "00000000-0000-4000-8000-000000000102";
      const revoked = await admin.putWriterGrant(command("1"), "writer-legacy", {
        active: false,
        sourceVersion: 2,
        sourceInvitationId: invitationV2,
      });
      assert.equal(revoked.status, "APPLIED");
      assert.deepEqual(await admin.putWriterGrant(command("1"), "writer-legacy", {
        active: false,
        sourceVersion: 2,
        sourceInvitationId: invitationV2,
      }), revoked);
      assert.deepEqual(await admin.putWriterGrant(command("1"), "writer-legacy", {
        active: true,
        sourceVersion: 3,
        sourceInvitationId: "00000000-0000-4000-8000-000000000103",
      }), { status: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" });

      assert.deepEqual(await admin.putWriterGrant(command("2"), "writer-legacy", {
        active: true,
        sourceVersion: 1,
        sourceInvitationId: "00000000-0000-4000-8000-000000000101",
      }), { status: "CONFLICT", reason: "SOURCE_VERSION" });
      assert.deepEqual(await admin.getWriterGrant("writer-legacy"), {
        nihoUserId: "writer-legacy",
        active: false,
        sourceVersion: 2,
        sourceInvitationId: invitationV2,
      });
      assert.equal((await admin.putWriterGrant(command("3"), "writer-legacy", {
        active: false,
        sourceVersion: 2,
        sourceInvitationId: invitationV2,
      })).status, "UNCHANGED");
      assert.deepEqual(await admin.putWriterGrant(command("4"), "writer-legacy", {
        active: false,
        sourceVersion: 2,
        sourceInvitationId: "00000000-0000-4000-8000-000000000199",
      }), { status: "CONFLICT", reason: "SOURCE_VERSION" });

      assert.deepEqual(await admin.listCategories(), [{
        slug: "legacy",
        labelEn: "Legacy",
        labelJa: "旧",
        displayOrder: 20,
        active: false,
        revision: 1,
      }]);
      assert.deepEqual(await new GuideRepository(pool).listActiveCategories(), []);

      const created = await admin.putCategory(command("5"), "culture", {
        labelEn: "Culture",
        labelJa: "文化",
        displayOrder: 10,
        active: true,
        expectedRevision: 0,
      });
      assert.equal(created.status, "APPLIED");
      if (created.status !== "APPLIED") return;
      assert.equal(created.category.revision, 1);

      const concurrent = await Promise.all([
        admin.putCategory(command("6"), "culture", {
          labelEn: "Culture and craft",
          labelJa: "文化と工芸",
          displayOrder: 10,
          active: true,
          expectedRevision: 1,
        }),
        admin.putCategory(command("7"), "culture", {
          labelEn: "Culture inactive",
          labelJa: "文化（停止）",
          displayOrder: 11,
          active: false,
          expectedRevision: 1,
        }),
      ]);
      assert.equal(concurrent.filter((result) => result.status === "APPLIED").length, 1);
      assert.equal(concurrent.filter((result) => result.status === "CONFLICT" && result.reason === "EXPECTED_REVISION").length, 1);
      assert.equal((await admin.listCategories()).find((category) => category.slug === "culture")?.revision, 2);

      const receipts = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM guide_admin_command_receipts");
      assert.equal(receipts.rows[0]?.count, "7");
      await assert.rejects(
        () => pool.query("UPDATE guide_admin_command_receipts SET action='writer.put' WHERE idempotency_key=$1::uuid", [command("5").idempotencyKey]),
        /append-only/,
      );
      await assert.rejects(
        () => pool.query("DELETE FROM guide_admin_command_receipts WHERE idempotency_key=$1::uuid", [command("5").idempotencyKey]),
        /append-only/,
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
