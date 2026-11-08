import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreRateLimitedError } from "../src/errors.ts";
import { HOST_TEAM_RESOLVE_LIMIT, HostTeamRepository } from "../src/host-team.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = `hst_${"01".repeat(16)}`;
const CANDIDATE = `hst_${"02".repeat(16)}`;
const EDITOR = `hst_${"03".repeat(16)}`;
const OTHER_OWNER = `hst_${"04".repeat(16)}`;
const PROVIDER = "synthetic-team-provider";
const ADD = "10000000-0000-4000-8000-000000000001";
const REMOVE = "10000000-0000-4000-8000-000000000002";

async function seed(pool: Pool) {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1),($2)", [PROVIDER, "other-provider"]);
  for (const [id, email] of [[OWNER, "owner@example.test"], [CANDIDATE, "candidate@example.test"], [EDITOR, "editor@example.test"], [OTHER_OWNER, "other@example.test"]]) {
    await pool.query("INSERT INTO host_accounts (id,email,email_key,status,created_at,updated_at) VALUES ($1,$2,$2,'ACTIVE',clock_timestamp(),clock_timestamp())", [id, email]);
  }
  await pool.query(
    `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES
     ($1,$2,'OWNER',true),($1,$3,'EDITOR',true),('other-provider',$4,'OWNER',true)`,
    [PROVIDER, OWNER, EDITOR, OTHER_OWNER],
  );
}

describe("Experience-native host team", { skip: databaseUrl === undefined }, () => {
  it("adds/removes only COHOST with CAS and safe command replay, and rechecks the actor before replay", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "host_team", { max: 6 });
    try {
      await seed(db.pool);
      const repository = new HostTeamRepository(db.pool);
      const actor = { providerId: PROVIDER, hostAccountId: OWNER };
      assert.deepEqual((await repository.list(actor)).members.map(({ hostAccountId, role }) => [hostAccountId, role]), [[OWNER, "OWNER"], [EDITOR, "EDITOR"]]);
      assert.deepEqual((await repository.list(actor)).members.map(({ label }) => label), ["owner@example.test", "editor@example.test"]);

      const resolved = await repository.resolve({ ...actor, email: "  CANDIDATE@EXAMPLE.TEST " });
      assert.equal(resolved.candidate?.hostAccountId, CANDIDATE);
      assert.equal(resolved.candidate?.label, "candidate@example.test");
      assert.equal((await repository.resolve({ ...actor, email: "unknown@example.test" })).candidate, null);

      const added = await repository.addCohost({ ...actor, targetHostAccountId: CANDIDATE, commandId: ADD, expectedRevision: 0 });
      assert.equal(added.teamRevision, 1); assert.equal(added.receipt.repeated, false);
      assert.equal((await repository.addCohost({ ...actor, targetHostAccountId: CANDIDATE, commandId: ADD, expectedRevision: 0 })).receipt.repeated, true);
      await assert.rejects(repository.addCohost({ ...actor, targetHostAccountId: CANDIDATE, commandId: ADD, expectedRevision: 1 }), StoreConflictError);
      await assert.rejects(repository.addCohost({ ...actor, targetHostAccountId: EDITOR, commandId: "10000000-0000-4000-8000-000000000003", expectedRevision: 1 }), StoreConflictError);
      await assert.rejects(repository.removeCohost({ ...actor, targetHostAccountId: OWNER, commandId: "10000000-0000-4000-8000-000000000004", expectedRevision: 1 }), StoreConflictError);

      const raced = await Promise.allSettled([
        repository.removeCohost({ ...actor, targetHostAccountId: CANDIDATE, commandId: REMOVE, expectedRevision: 1 }),
        repository.addCohost({ ...actor, targetHostAccountId: CANDIDATE, commandId: "10000000-0000-4000-8000-000000000005", expectedRevision: 1 }),
      ]);
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(raced.filter((result) => result.status === "rejected" && result.reason instanceof StoreConflictError).length, 1);
      const removed = raced.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<HostTeamRepository["removeCohost"]>>> => result.status === "fulfilled")!.value;
      assert.equal(removed.teamRevision, 2); assert.equal(removed.members.some((member) => member.hostAccountId === CANDIDATE), false);
      await assert.rejects(repository.addCohost({ ...actor, targetHostAccountId: CANDIDATE, commandId: ADD, expectedRevision: 0 }), StoreConflictError);

      await db.pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id=$2", [PROVIDER, OWNER]);
      await assert.rejects(repository.removeCohost({ ...actor, targetHostAccountId: CANDIDATE, commandId: REMOVE, expectedRevision: 1 }), StoreAccessDeniedError);
      await db.pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'OWNER',true)", [PROVIDER, OTHER_OWNER]);
      await assert.rejects(repository.addCohost({ providerId: PROVIDER, hostAccountId: OTHER_OWNER, targetHostAccountId: CANDIDATE, commandId: ADD, expectedRevision: 0 }), StoreConflictError);
      assert.equal((await db.pool.query("SELECT role,active FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2", [PROVIDER, CANDIDATE])).rows[0].active, false);
    } finally { await db.dispose(); }
  });

  it("rate limits exact resolve per provider and owner without persisting the searched email", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "host_team_rate", { max: 4 });
    try {
      await seed(db.pool); const repository = new HostTeamRepository(db.pool); const actor = { providerId: PROVIDER, hostAccountId: OWNER };
      for (let index = 0; index < HOST_TEAM_RESOLVE_LIMIT; index += 1) await repository.resolve({ ...actor, email: `unknown-${index}@example.test` });
      await assert.rejects(repository.resolve({ ...actor, email: "over@example.test" }), StoreRateLimitedError);
      const columns = (await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='provider_team_resolve_buckets' ORDER BY column_name")).rows.map((row) => row.column_name);
      assert.equal(columns.some((column) => String(column).includes("email")), false);
      const receiptColumns = (await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='provider_team_commands' ORDER BY column_name")).rows.map((row) => row.column_name);
      assert.equal(receiptColumns.some((column) => String(column).includes("email")), false);
    } finally { await db.dispose(); }
  });
});
